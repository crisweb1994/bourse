/**
 * plan-v2 Wave 2 — single `fetchSnapshot()` entry point.
 *
 * Replaces (collectively):
 *   - packages/planning/src/snapshot/builder.ts (568 lines)
 *   - packages/planning/src/orchestrators/* (1146 lines)
 *   - packages/planning/src/planner/compiler/* (651 lines)
 *
 * Behavior:
 *   1. For each configured fetcher on the market, race a per-connector
 *      timeout (default 8s) against the fetch. Fail-soft: on error the
 *      fact lands as `null` + a `dataAvailability.missing` entry with
 *      a structured reason.
 *   2. After all fetchers settle, run the compute layer
 *      (financial-ratios / technical-indicators / red-flags / valuation
 *      / historicalContext). Compute warnings → dataAvailability.warnings.
 *   3. Collect citations into a flat pack-level array (plan-v2
 *      invariant #4: provenance is pack-level, not per-Fact<T>).
 *
 * No I/O outside the caller-supplied MarketConfig fetchers. No LLM
 * calls. No persistence. Pure orchestration.
 */

import {
  computeFinancialRatios,
  computeHistoricalContext,
  computeTechnicalIndicators,
  computeValuation,
  detectRedFlags,
  type ComputeWarning,
  type HistoricalContext,
} from '../compute';
import type {
  ComputedFacts,
  DataAvailability,
  RawFacts,
  SnapshotCitation,
  SnapshotMissingField,
  SnapshotMissingReason,
  SnapshotSourceMetadata,
  StockSnapshot,
} from './types';
import type {
  Market,
  MarketConfig,
  MarketConfigMap,
  SnapshotFetcherEnvelope,
} from './market-config';
import type { ConnectorRunContext } from '@bourse/market-data';

// ----------------------------------------------------------------------------
// Options
// ----------------------------------------------------------------------------

export interface FetchSnapshotOptions {
  symbol: string;
  market: Market;
  configs: MarketConfigMap;
  /** Per-connector timeout (ms). Default 8000. */
  perConnectorTimeoutMs?: number;
  /** History window in days back. Default 365. */
  historyDays?: number;
  /** Filings limit. Default 10. */
  filingsLimit?: number;
  /** External abort signal (caller cancellation). */
  signal?: AbortSignal;
}

const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_HISTORY_DAYS = 365;
const DEFAULT_FILINGS_LIMIT = 10;

// ----------------------------------------------------------------------------
// Public API
// ----------------------------------------------------------------------------

export async function fetchSnapshot(
  options: FetchSnapshotOptions,
): Promise<StockSnapshot> {
  const config = options.configs[options.market];
  if (!config) {
    throw new Error(
      `fetchSnapshot: no MarketConfig for market=${options.market}`,
    );
  }

  const capturedAt = new Date().toISOString();
  const timeoutMs = options.perConnectorTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const historyDays = options.historyDays ?? DEFAULT_HISTORY_DAYS;
  const filingsLimit = options.filingsLimit ?? DEFAULT_FILINGS_LIMIT;

  // 1. Build & run fetcher list in parallel ----------------------------------
  const today = capturedAt.slice(0, 10);
  const fromDate = isoDaysAgo(historyDays);

  const tasks: FetcherTask[] = [
    task('quote', config.quote ? (ctx) => config.quote(options.symbol, ctx) : null),
    task(
      'history',
      config.history
        ? (ctx) => config.history!(options.symbol, fromDate, today, ctx)
        : null,
    ),
    task('profile', config.profile ? (ctx) => config.profile!(options.symbol, ctx) : null),
    task('financials', config.financials ? (ctx) => config.financials!(options.symbol, ctx) : null),
    task(
      'filings',
      config.filings ? (ctx) => config.filings!(options.symbol, filingsLimit, ctx) : null,
    ),
    task('consensusEps', config.consensusEps ? (ctx) => config.consensusEps!(options.symbol, ctx) : null),
    task('northboundFlow', config.northboundFlow ? (ctx) => config.northboundFlow!(options.symbol, ctx) : null),
    task('lhb', config.lhb ? (ctx) => config.lhb!(options.symbol, ctx) : null),
    task('unlockCalendar', config.unlockCalendar ? (ctx) => config.unlockCalendar!(options.symbol, ctx) : null),
    task('shareholders', config.shareholders ? (ctx) => config.shareholders!(options.symbol, ctx) : null),
    task('corporateActions', config.corporateActions ? (ctx) => config.corporateActions!(options.symbol, ctx) : null),
    task('ownership', config.ownership ? (ctx) => config.ownership!(options.symbol, ctx) : null),
    task('marketEvents', config.marketEvents ? (ctx) => config.marketEvents!(options.symbol, ctx) : null),
    task('webSearch', config.webSearch ? (ctx) => config.webSearch!(options.symbol, ctx) : null),
    task('macro', config.macro ? (ctx) => config.macro!(options.symbol, ctx) : null),
  ];

  const results = await Promise.all(
    tasks.map((t) => runWithTimeout(t, timeoutMs, options.signal)),
  );

  const rawFacts = assembleRawFacts(results);
  const dataAvailability = assembleAvailability(results);

  // 2. Compute layer ---------------------------------------------------------
  const computedFacts = runComputeLayer(rawFacts, options.market, dataAvailability);

  // 3. Preserve connector provenance. A source that did not produce a usable
  // fact cannot become a citation for the run.
  const citations = dedupeCitations(results.flatMap((result) => result.citations));
  const sourceMetadata = Object.fromEntries(
    results.flatMap((result) =>
      result.metadata ? [[result.field, result.metadata] as const] : [],
    ),
  ) as Partial<Record<keyof RawFacts, SnapshotSourceMetadata>>;

  return {
    symbol: options.symbol,
    market: options.market,
    capturedAt,
    rawFacts,
    computedFacts,
    citations,
    dataAvailability,
    ...(Object.keys(sourceMetadata).length > 0 ? { sourceMetadata } : {}),
  };
}

// ============================================================================
// Internals
// ============================================================================

interface FetcherTask {
  field: keyof RawFacts;
  fn: ((ctx: ConnectorRunContext) => Promise<unknown>) | null;
}

function task(
  field: keyof RawFacts,
  fn: ((ctx: ConnectorRunContext) => Promise<unknown>) | null,
): FetcherTask {
  return { field, fn };
}

interface FetcherResult {
  field: keyof RawFacts;
  value: unknown;
  missing: SnapshotMissingField | null;
  citations: SnapshotCitation[];
  metadata?: SnapshotSourceMetadata;
  warnings: string[];
}

async function runWithTimeout(
  t: FetcherTask,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<FetcherResult> {
  if (!t.fn) {
    return {
      field: t.field,
      value: null,
      missing: { field: t.field, reason: 'not_configured' },
      citations: [],
      warnings: [],
    };
  }
  if (signal?.aborted) {
    return {
      field: t.field,
      value: null,
      missing: { field: t.field, reason: 'timeout', detail: 'caller aborted' },
      citations: [],
      warnings: [],
    };
  }

  const controller = new AbortController();
  let timedOut = false;
  const onCallerAbort = () => controller.abort(signal?.reason);
  if (signal?.aborted) onCallerAbort();
  else signal?.addEventListener('abort', onCallerAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error(`timeout after ${timeoutMs}ms`));
  }, timeoutMs);
  try {
    const response = await Promise.race([
      t.fn({ signal: controller.signal, timeoutMs }),
      new Promise<never>((_, reject) => {
        controller.signal.addEventListener('abort', () => {
          reject(Object.assign(
            new Error(timedOut ? `timeout after ${timeoutMs}ms` : 'caller aborted'),
            { __timeout: true },
          ));
        }, { once: true });
      }),
    ]);
    const envelope = isSnapshotFetcherEnvelope(response) ? response : null;
    const value = envelope ? envelope.data : response;
    const metadata = envelope ? toSourceMetadata(envelope) : undefined;
    const warnings = envelope ? formatConnectorWarnings(t.field, envelope) : [];

    if (value === null || value === undefined) {
      return {
        field: t.field,
        value: null,
        missing: {
          field: t.field,
          reason: envelope ? reasonFromWarnings(envelope) : 'no_data',
          ...(envelopeWarningDetail(envelope) ? { detail: envelopeWarningDetail(envelope) } : {}),
        },
        citations: [],
        ...(metadata ? { metadata } : {}),
        warnings,
      };
    }

    const usability = factUsability(t.field, value);
    if (usability !== 'valid') {
      return {
        field: t.field,
        value: null,
        missing: {
          field: t.field,
          reason: usability,
          detail: invalidFactDetail(t.field, value),
        },
        citations: [],
        ...(metadata ? { metadata } : {}),
        warnings,
      };
    }

    return {
      field: t.field,
      value,
      missing: null,
      citations: envelope ? citationsFromEnvelope(t.field, envelope) : [],
      ...(metadata ? { metadata } : {}),
      warnings,
    };
  } catch (err) {
    const reason = classifyError(err);
    const detail = err instanceof Error ? err.message : String(err);
    return {
      field: t.field,
      value: null,
      missing: { field: t.field, reason, detail },
      citations: [],
      warnings: [],
    };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onCallerAbort);
  }
}

function classifyError(err: unknown): SnapshotMissingField['reason'] {
  if (err && typeof err === 'object') {
    const e = err as { __timeout?: boolean; reason?: string; message?: string };
    if (e.__timeout) return 'timeout';
    if (e.reason === 'not_implemented') return 'not_implemented';
    if (typeof e.message === 'string') {
      if (/429|rate.?limit|retry-after/i.test(e.message)) return 'rate_limited';
      if (/timeout/i.test(e.message)) return 'timeout';
    }
  }
  return 'connector_error';
}

function isSnapshotFetcherEnvelope(
  value: unknown,
): value is SnapshotFetcherEnvelope<unknown> {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (
    'data' in candidate &&
    Array.isArray(candidate.citations) &&
    (candidate.warnings === undefined || Array.isArray(candidate.warnings)) &&
    (candidate.freshness === undefined || Array.isArray(candidate.freshness))
  );
}

function toSourceMetadata(
  envelope: SnapshotFetcherEnvelope<unknown>,
): SnapshotSourceMetadata {
  return {
    freshness: envelope.freshness ? [...envelope.freshness] : [],
    warnings: (envelope.warnings ?? []).map((warning) => ({
      code: warning.code,
      message: warning.message,
      ...(warning.provider ? { provider: warning.provider } : {}),
      ...(warning.cause ? { cause: warning.cause } : {}),
    })),
    ...(envelope.trace ? { trace: envelope.trace } : {}),
    ...(envelope.cost !== undefined ? { cost: envelope.cost } : {}),
  };
}

function citationsFromEnvelope(
  field: keyof RawFacts,
  envelope: SnapshotFetcherEnvelope<unknown>,
): SnapshotCitation[] {
  return envelope.citations.flatMap((citation) => {
    if (!citation.url || !isHttpUrl(citation.url) || !isIsoDate(citation.retrievedAt)) {
      return [];
    }
    const freshness = envelope.freshness?.find(
      (item) => item.provider === citation.provider,
    ) ?? envelope.freshness?.[0];
    return [{
      factKey: field,
      title: citation.title,
      url: citation.url,
      retrievedAt: citation.retrievedAt,
      ...(freshness?.asOf ? { asOf: freshness.asOf } : {}),
      provider: citation.provider,
      sourceType: citation.sourceType,
      ...(citation.qualityTier ? { qualityTier: citation.qualityTier } : {}),
    }];
  });
}

function dedupeCitations(citations: SnapshotCitation[]): SnapshotCitation[] {
  const seen = new Set<string>();
  return citations.filter((citation) => {
    const key = `${citation.factKey}:${citation.url}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function reasonFromWarnings(
  envelope: SnapshotFetcherEnvelope<unknown>,
): SnapshotMissingReason {
  const codes = new Set((envelope.warnings ?? []).map((warning) => warning.code));
  if (codes.has('RATE_LIMITED')) return 'rate_limited';
  if (codes.has('AUTH_REQUIRED')) return 'auth_required';
  if (codes.has('UNSUPPORTED_MARKET')) return 'not_implemented';
  if (codes.has('INVALID_INSTRUMENT')) return 'invalid_data';
  if (codes.has('SOURCE_UNAVAILABLE') || codes.has('SCRAPE_FAILED')) {
    return 'connector_error';
  }
  return 'no_data';
}

function envelopeWarningDetail(
  envelope: SnapshotFetcherEnvelope<unknown> | null,
): string | undefined {
  const messages = (envelope?.warnings ?? [])
    .map((warning) => warning.message)
    .filter(Boolean);
  return messages.length > 0 ? messages.join('; ') : undefined;
}

function formatConnectorWarnings(
  field: keyof RawFacts,
  envelope: SnapshotFetcherEnvelope<unknown>,
): string[] {
  return (envelope.warnings ?? []).map((warning) => {
    const provider = warning.provider ? `${warning.provider}: ` : '';
    return `${field}/${warning.code}: ${provider}${warning.message}`;
  });
}

type FactUsability = 'valid' | 'no_data' | 'invalid_data';

function factUsability(field: keyof RawFacts, value: unknown): FactUsability {
  if (field === 'history') {
    if (!Array.isArray(value)) return 'invalid_data';
    if (value.length === 0) return 'no_data';
    const bars = value as Array<Record<string, unknown>>;
    return bars.some(
      (bar) =>
        typeof bar.close === 'number' &&
        Number.isFinite(bar.close) &&
        bar.close > 0 &&
        typeof bar.timestamp === 'string',
    )
      ? 'valid'
      : 'invalid_data';
  }
  if (Array.isArray(value)) return value.length > 0 ? 'valid' : 'no_data';
  if (!value || typeof value !== 'object') return 'invalid_data';

  const record = value as Record<string, unknown>;
  if (field === 'quote') {
    return typeof record.price === 'number' && Number.isFinite(record.price) && record.price > 0
      ? 'valid'
      : 'invalid_data';
  }
  if (field === 'financials') {
    return Array.isArray(record.periods) && record.periods.length > 0
      ? 'valid'
      : 'no_data';
  }
  if (field === 'macro') {
    return Array.isArray(record.observations) && record.observations.length > 0
      ? 'valid'
      : 'no_data';
  }

  // Profiles containing only the instrument sentinel and empty wrapper
  // objects are not research facts. Other object-shaped extras are accepted
  // because their individual adapters own the detailed schema validation.
  const keys = Object.keys(record).filter((key) => key !== 'instrument');
  return keys.length > 0 ? 'valid' : 'no_data';
}

function invalidFactDetail(field: keyof RawFacts, value: unknown): string {
  if (Array.isArray(value) && value.length === 0) return `${field} returned an empty array`;
  if (field === 'quote') return 'quote.price must be a finite positive number';
  if (field === 'history') return 'history contains no valid positive close prices';
  return `${field} returned an unusable payload`;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

function isIsoDate(value: string): boolean {
  return !Number.isNaN(Date.parse(value));
}

function assembleRawFacts(results: FetcherResult[]): RawFacts {
  const r: Partial<RawFacts> = {};
  for (const result of results) {
    (r as Record<string, unknown>)[result.field] = result.value;
  }
  // Ensure all keys exist (RawFacts has no optional fields by design)
  return {
    quote: (r.quote as RawFacts['quote']) ?? null,
    history: (r.history as RawFacts['history']) ?? null,
    profile: (r.profile as RawFacts['profile']) ?? null,
    financials: (r.financials as RawFacts['financials']) ?? null,
    filings: (r.filings as RawFacts['filings']) ?? null,
    consensusEps: r.consensusEps ?? null,
    northboundFlow: r.northboundFlow ?? null,
    lhb: r.lhb ?? null,
    unlockCalendar: r.unlockCalendar ?? null,
    shareholders: r.shareholders ?? null,
    corporateActions: r.corporateActions ?? null,
    ownership: r.ownership ?? null,
    marketEvents: r.marketEvents ?? null,
    webSearch: r.webSearch ?? null,
    macro: r.macro ?? null,
  };
}

function assembleAvailability(results: FetcherResult[]): DataAvailability {
  const available: string[] = [];
  const missing: SnapshotMissingField[] = [];
  const warnings: string[] = [];
  for (const r of results) {
    if (r.missing) missing.push(r.missing);
    else available.push(r.field);
    warnings.push(...r.warnings);
  }
  return { available, missing, warnings };
}

function runComputeLayer(
  rawFacts: RawFacts,
  market: Market,
  availability: DataAvailability,
): ComputedFacts {
  const warnings: ComputeWarning[] = [];

  const ratiosOut = computeFinancialRatios({
    bundle: rawFacts.financials,
    quote: rawFacts.quote,
    market,
  });
  warnings.push(...ratiosOut.warnings);

  const techOut = computeTechnicalIndicators({
    bars: rawFacts.history ?? [],
  });
  warnings.push(...techOut.warnings);

  const redFlags = detectRedFlags({
    bundle: rawFacts.financials,
    ratios: ratiosOut.ratios,
  });

  const valuationOut = computeValuation({
    bundle: rawFacts.financials,
    quote: rawFacts.quote,
    history: rawFacts.history,
    market,
    consensusEpsGrowth: deriveConsensusEpsGrowth(rawFacts.consensusEps),
  });
  warnings.push(...valuationOut.warnings);

  // historicalContext: PE only for now (derived from valuation.peHistorySeries)
  const historicalContext: HistoricalContext[] = [];
  if (
    valuationOut.valuation &&
    valuationOut.valuation.peHistorySeries.length > 0
  ) {
    const peCtx = computeHistoricalContext({
      metric: 'pe',
      current: ratiosOut.ratios?.pe ?? null,
      history: valuationOut.valuation.peHistorySeries.map((e) => ({
        period: e.period,
        value: e.pe,
      })),
    });
    if (peCtx.history.length > 0) historicalContext.push(peCtx);
  }

  // Surface compute warnings into the snapshot's availability block
  for (const w of warnings) {
    availability.warnings.push(`${w.code}/${w.metric}: ${w.detail}`);
  }

  return {
    financialRatios: ratiosOut.ratios,
    technicalIndicators: techOut.indicators,
    redFlags,
    valuation: valuationOut.valuation,
    peerComparison: null,
    historicalContext,
  };
}

/**
 * Derive forward EPS YoY growth from a consensusEps payload.
 * The payload uses the canonical earnings-consensus estimate model supplied
 * through market-data. Returns null when there is insufficient data.
 */
function deriveConsensusEpsGrowth(raw: RawFacts['consensusEps']): number | null {
  if (!raw) return null;
  const sorted = raw.estimates
    .filter((estimate) => estimate.metricCode === 'epsBasic')
    .map((estimate) => ({
      year: Number(estimate.periodEndOn.slice(0, 4)),
      value: Number(estimate.value),
    }))
    .filter((estimate) => Number.isInteger(estimate.year) && Number.isFinite(estimate.value))
    .sort((a, b) => a.year - b.year);
  if (sorted.length < 2) return null;
  const y0 = sorted[0]!;
  const y1 = sorted[1]!;
  if (y0.value <= 0) return null;
  return (y1.value - y0.value) / y0.value;
}

function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}
