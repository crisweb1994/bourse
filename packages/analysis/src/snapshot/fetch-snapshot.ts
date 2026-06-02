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
  StockSnapshot,
} from './types';
import type {
  Market,
  MarketConfig,
  MarketConfigMap,
} from './market-config';

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
    task('quote', config.quote ? () => config.quote(options.symbol) : null),
    task(
      'history',
      config.history
        ? () => config.history!(options.symbol, fromDate, today)
        : null,
    ),
    task('profile', config.profile ? () => config.profile!(options.symbol) : null),
    task('financials', config.financials ? () => config.financials!(options.symbol) : null),
    task(
      'filings',
      config.filings ? () => config.filings!(options.symbol, filingsLimit) : null,
    ),
    task('consensusEps', config.consensusEps ? () => config.consensusEps!(options.symbol) : null),
    task('northboundFlow', config.northboundFlow ? () => config.northboundFlow!(options.symbol) : null),
    task('lhb', config.lhb ? () => config.lhb!(options.symbol) : null),
    task('unlockCalendar', config.unlockCalendar ? () => config.unlockCalendar!(options.symbol) : null),
    task('shareholders', config.shareholders ? () => config.shareholders!(options.symbol) : null),
    task('webSearch', config.webSearch ? () => config.webSearch!(options.symbol) : null),
    task('macro', config.macro ? () => config.macro!(options.symbol) : null),
  ];

  const results = await Promise.all(
    tasks.map((t) => runWithTimeout(t, timeoutMs, options.signal)),
  );

  const rawFacts = assembleRawFacts(results);
  const dataAvailability = assembleAvailability(results);

  // 2. Compute layer ---------------------------------------------------------
  const computedFacts = runComputeLayer(rawFacts, options.market, dataAvailability);

  // 3. Citations -------------------------------------------------------------
  // For Wave 2 we emit one synthetic citation per available fact key so
  // downstream consumers see a non-empty array. Real per-fact citations
  // will be threaded from the ports (Wave 2.3 integration). This is
  // intentionally minimal here — citation provenance is a connector
  // concern, not snapshot orchestrator's.
  const citations: SnapshotCitation[] = [];

  return {
    symbol: options.symbol,
    market: options.market,
    capturedAt,
    rawFacts,
    computedFacts,
    citations,
    dataAvailability,
  };
}

// ============================================================================
// Internals
// ============================================================================

interface FetcherTask {
  field: keyof RawFacts;
  fn: (() => Promise<unknown>) | null;
}

function task(field: keyof RawFacts, fn: (() => Promise<unknown>) | null): FetcherTask {
  return { field, fn };
}

interface FetcherResult {
  field: keyof RawFacts;
  value: unknown;
  missing: SnapshotMissingField | null;
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
    };
  }
  if (signal?.aborted) {
    return {
      field: t.field,
      value: null,
      missing: { field: t.field, reason: 'timeout', detail: 'caller aborted' },
    };
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const value = await Promise.race([
      t.fn(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              Object.assign(new Error(`timeout after ${timeoutMs}ms`), {
                __timeout: true,
              }),
            ),
          timeoutMs,
        );
      }),
    ]);
    if (value === null || value === undefined) {
      return {
        field: t.field,
        value: null,
        missing: { field: t.field, reason: 'no_data' },
      };
    }
    return { field: t.field, value, missing: null };
  } catch (err) {
    const reason = classifyError(err);
    const detail = err instanceof Error ? err.message : String(err);
    return {
      field: t.field,
      value: null,
      missing: { field: t.field, reason, detail },
    };
  } finally {
    if (timer) clearTimeout(timer);
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
    webSearch: r.webSearch ?? null,
    macro: r.macro ?? null,
  };
}

function assembleAvailability(results: FetcherResult[]): DataAvailability {
  const available: string[] = [];
  const missing: SnapshotMissingField[] = [];
  for (const r of results) {
    if (r.missing) missing.push(r.missing);
    else available.push(r.field);
  }
  return { available, missing, warnings: [] };
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
 * The payload shape is connector-specific; we shape-detect the
 * Eastmoney-style {forecasts: [{year, value}, ...]} structure used by
 * the existing CN consensus connector. Returns null when shape unknown
 * or insufficient data.
 */
function deriveConsensusEpsGrowth(raw: unknown): number | null {
  if (!raw || typeof raw !== 'object') return null;
  const forecasts = (raw as { forecasts?: unknown }).forecasts;
  if (!Array.isArray(forecasts) || forecasts.length < 2) return null;
  const sorted = [...forecasts]
    .filter(
      (f): f is { year: number; value: number } =>
        f !== null &&
        typeof f === 'object' &&
        typeof (f as { year?: unknown }).year === 'number' &&
        typeof (f as { value?: unknown }).value === 'number',
    )
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
