/**
 * plan-v2 Wave 2.4 — StockSnapshot → EvidencePackV2 adapter.
 *
 * Wave 2.4 chose Path A: keep dimension agents reading EvidencePackV2
 * (existing prompt assembly + structuredJson + citation policy stay
 * byte-stable), and bridge from the new StockSnapshot value with this
 * adapter. The bridge is the only place that knows both shapes.
 *
 * Mapping rules:
 *  - rawFacts.quote → facts.{quote, marketCap, currency, pe}
 *    (Quote has these as scalar fields; each becomes its own Fact<T>.)
 *  - rawFacts.financials → facts.financials (FinancialsBundle passthrough)
 *  - rawFacts.filings → facts.latestFilingUrls
 *  - rawFacts.consensusEps → facts.consensusEps (Eastmoney-shape detected)
 *  - rawFacts.northboundFlow → facts.northboundFlow
 *  - Stock Connect holding observations → facts.northboundHoldings
 *  - rawFacts.lhb → facts.lhbAppearances (project rich seat objects to
 *    legacy name list per Wave 1.9)
 *  - rawFacts.unlockCalendar → facts.unlockCalendar
 *  - rawFacts.shareholders → facts.shareholderConcentration (derive top10
 *    from holderTotalNum stats; emit `null` when shape unknown)
 *  - computedFacts → pack.computedFacts (Wave 1.2 field, byte passthrough)
 *
 * Provenance:
 *  - sourceUrl / asOf / retrievedAt / sourceTier come from the connector
 *    citation matching the fact key
 *  - facts without a verifiable HTTP source are omitted rather than being
 *    stamped with a synthetic URL
 *  - origin = 'from_snapshot' (existing v0.6 PRD discriminator)
 *
 * Cosmetic: dataAvailability.missing reasons are mapped 1:1 from
 * StockSnapshot.missing to EvidencePackV2.missing's free-text reason
 * (EvidencePack doesn't have structured codes today).
 */

import type {
  ComputedFactsBlock,
  EvidencePackDataAvailability,
  EvidencePackMarket,
  EvidencePackV2,
  FactOf,
  SourceTier,
} from '../contracts/evidence-pack-v2';
import type { FinancialsBundle, MarketEvent, OwnershipObservation } from '@bourse/market-data';
import type { StockSnapshot } from './types';
import { buildResearchCoverage } from './research-coverage';

const DEFAULT_TIER: SourceTier = 'B';

export interface ToEvidencePackOptions {
  /** Optional plan id to stamp into trace.planId. */
  planId?: string;
  /** Optional snapshot id (e.g. when persisted in caller layer). */
  snapshotId?: string;
}

export function snapshotToEvidencePack(
  snap: StockSnapshot,
  opts: ToEvidencePackOptions = {},
): EvidencePackV2 {
  const citationByField = indexCitationsByField(snap);
  // ── facts construction ──────────────────────────────────────────────────
  const facts: EvidencePackV2['facts'] = {};
  const putFact = <T>(
    key: string,
    value: T,
    options: {
      sourceField?: string;
      extra?: Partial<FactOf<T>>;
    } = {},
  ): void => {
    const citation = citationByField.get(options.sourceField ?? key);
    if (!citation) return;
    (facts as Record<string, unknown>)[key] = {
      value,
      asOf: citation.asOf ?? citation.retrievedAt,
      retrievedAt: citation.retrievedAt,
      sourceUrl: citation.url,
      sourceTier: citation.qualityTier ?? DEFAULT_TIER,
      origin: 'from_snapshot' as const,
      ...(options.extra ?? {}),
    } satisfies FactOf<T>;
  };

  // Quote → quote / marketCap / currency / pe
  const q = snap.rawFacts.quote;
  if (q) {
    if (q.price > 0) putFact('quote', q.price, { extra: { unit: q.currency } });
    if (q.marketCap !== undefined && q.marketCap > 0) {
      putFact('marketCap', q.marketCap, { sourceField: 'quote', extra: { currency: q.currency } });
    }
    if (typeof q.currency === 'string' && q.currency.length === 3) {
      putFact('currency', q.currency, { sourceField: 'quote' });
    }
    if (q.peRatio !== undefined && Number.isFinite(q.peRatio)) {
      putFact('pe', q.peRatio, { sourceField: 'quote' });
    }
  }

  // Profile → facts.profile (Yahoo assetProfile / Eastmoney F10 基本资料).
  // The connector emits a CompanyProfile object (with an `instrument` field we
  // drop here); project the descriptive scalars. Tier B (vendor F10 / Yahoo
  // profile, not a primary regulatory filing).
  const prof = snap.rawFacts.profile;
  if (prof) {
    const value: Record<string, unknown> = {};
    if (prof.description) value.description = prof.description;
    if (prof.sector) value.sector = prof.sector;
    if (prof.industry) value.industry = prof.industry;
    if (typeof prof.employees === 'number' && Number.isFinite(prof.employees)) value.employees = prof.employees;
    if (prof.website) value.website = prof.website;
    if (typeof prof.marketCap === 'number' && Number.isFinite(prof.marketCap)) value.marketCap = prof.marketCap;
    if (Object.keys(value).length > 0) {
      putFact('profile', value);
    }
  }

  // Financials passthrough
  if (snap.rawFacts.financials) {
    putFact('financials', snap.rawFacts.financials as FinancialsBundle, {
      extra: { sourceTier: pickFinancialsTier(snap.rawFacts.financials) },
    });
  }

  // Filings → latestFilingUrls
  if (snap.rawFacts.filings && Array.isArray(snap.rawFacts.filings)) {
    const urls = snap.rawFacts.filings
      .map((f) => extractFilingUrl(f))
      .filter((u): u is string => typeof u === 'string' && u.length > 0)
      .slice(0, 10);
    if (urls.length > 0) {
      putFact('latestFilingUrls', urls, { sourceField: 'filings' });
    }
  }

  // Search is evidence discovery, not a substitute for structured financial
  // facts. Preserve the returned documents so qualitative dimensions can
  // inspect their actual URLs and dates.
  const webDocuments = projectWebDocuments(snap.rawFacts.webSearch);
  if (webDocuments.length > 0) {
    putFact('webDocuments', webDocuments, { sourceField: 'webSearch' });
    const recentNews = webDocuments
      .filter((item) => item.sourceType === 'news' && item.publishedAt)
      .map((item) => ({
        title: item.title,
        url: item.url,
        publishedAt: item.publishedAt!,
      }));
    if (recentNews.length > 0) {
      putFact('recentNews', recentNews, { sourceField: 'webSearch' });
    }
  }

  const macro = snap.rawFacts.macro;
  if (macro && macro.observations.length > 0) {
    putFact('macro', macro);
  }

  if (snap.rawFacts.corporateActions?.length) {
    putFact('corporateActions', snap.rawFacts.corporateActions);
  }
  if (snap.rawFacts.ownership?.length) {
    putFact('ownershipObservations', snap.rawFacts.ownership, { sourceField: 'ownership' });
  }
  if (snap.rawFacts.marketEvents?.length) {
    putFact('marketEvents', snap.rawFacts.marketEvents);
  }

  // Consensus is canonical at the snapshot boundary; EvidencePack keeps its
  // compact year/value projection for prompt compatibility.
  const ce = snap.rawFacts.consensusEps;
  if (ce) {
    const forecasts = ce.estimates
      .filter((estimate) => estimate.metricCode === 'epsBasic')
      .map((estimate) => ({
        year: Number(estimate.periodEndOn.slice(0, 4)),
        value: Number(estimate.value),
      }))
      .filter((estimate) => Number.isInteger(estimate.year) && Number.isFinite(estimate.value));
    if (forecasts.length > 0) {
      putFact('consensusEps', forecasts);
    }
  }

  // Stock Connect ownership observations -> legacy northbound flow rows.
  const nbf = snap.rawFacts.northboundFlow;
  const northboundFlowRows = nbf
    ?.filter(isStockConnectObservation)
    .map((row) => ({
      date: row.asOf,
      hgt: Number(row.shanghaiNetFlow),
      sgt: Number(row.shenzhenNetFlow),
    }))
    .filter((row) => Number.isFinite(row.hgt) && Number.isFinite(row.sgt)) ?? [];
  const northboundHoldingRows = nbf
    ?.filter(isStockConnectHoldingObservation)
    .map((row) => ({
      date: row.asOf,
      ...(row.exchange ? { exchange: row.exchange } : {}),
      holdingShares: Number(row.holdingShares),
      ...(row.holdingPercentOfFloat !== null && row.holdingPercentOfFloat !== undefined
        ? { holdingPercentOfFloat: Number(row.holdingPercentOfFloat) }
        : {}),
    }))
    .filter((row) => Number.isFinite(row.holdingShares) && (
      row.holdingPercentOfFloat === undefined || Number.isFinite(row.holdingPercentOfFloat)
    )) ?? [];
  if (nbf) {
    if (northboundFlowRows.length > 0) {
      putFact('northboundFlow', northboundFlowRows);
    }

    // Tushare's hk_hold endpoint reports holdings, not net capital flow.
    // Preserve those observations separately instead of coercing them into
    // hgt/sgt flow rows with a different unit and meaning.
    if (northboundHoldingRows.length > 0) {
      putFact('northboundHoldings', northboundHoldingRows, { sourceField: 'northboundFlow' });
    }
  }

  // Canonical LHB events -> legacy name lists used by prompts.
  const lhb = snap.rawFacts.lhb;
  if (lhb) {
    const apps = lhb
      .filter(isLhbEvent)
      .map((event) => ({
        date: event.occurredAt,
        reason: event.reason,
        topBuySeats: event.topBuySeatNames,
        topSellSeats: event.topSellSeatNames,
      }));
    if (apps.length > 0) {
      putFact('lhbAppearances', apps, { sourceField: 'lhb' });
    }
  }

  // Canonical unlock events -> legacy EvidencePack projection.
  const uc = snap.rawFacts.unlockCalendar;
  if (uc) {
    const events = uc
      .filter(isUnlockEvent)
      .map((event) => ({
        date: event.effectiveAt ?? event.occurredAt,
        shares: Number(event.shares),
        ...(event.marketValue === undefined ? {} : { marketValue: Number(event.marketValue) / 100_000_000 }),
        type: event.unlockType,
      }))
      .filter((event) => Number.isFinite(event.shares) && event.shares > 0);
    if (events.length > 0) {
      putFact('unlockCalendar', events);
    }
  }

  // shareholderConcentration — derive from snapshot.shareholders rows when
  // shape is recognizable. Plan-v2 Wave 1.6 connector emits an array of
  // ShareholdersRow; the EvidencePack shape wants {top10Ratio,
  // institutionRatio?, northboundRatio?, retailRatio?}. The connector
  // doesn't deliver top10 ratio (different endpoint); we leave this null
  // for now until shareholders connector grows the top10 stats. Surface
  // a structural placeholder so dim prompts know data was collected.
  const sh = snap.rawFacts.shareholders;
  if (sh) {
    const observations = sh.filter((item) => item.kind === 'SHAREHOLDER_COUNT');
    if (observations.length > 0) {
      // The legacy ShareholderConcentration schema requires top10Ratio
      // (number 0-1). We can't fabricate it from holder-count data, so
      // we skip the fact rather than emit a wrong value. Surface in
      // dataAvailability instead so prompts know the data exists in
      // raw form on the snapshot.
      // (Future: shareholders connector should expose top10 ratio when
      // RPT_F10_EH_FREEHOLDERS or similar is wired.)
      void observations;
    }
  }

  // ── dataAvailability ────────────────────────────────────────────────────
  const available = new Set(snap.dataAvailability.available);
  const missing = snap.dataAvailability.missing.map((m) => ({
    field: m.field,
    reason: m.detail ? `${m.reason}: ${m.detail}` : m.reason,
  }));
  if (northboundHoldingRows.length > 0) {
    available.add('northboundHoldings');
    if (northboundFlowRows.length === 0 && available.delete('northboundFlow')) {
      missing.push({ field: 'northboundFlow', reason: 'no_data: source returned holdings, not net flow' });
    }
  }
  const availability: EvidencePackDataAvailability = {
    complete: [...available],
    missing,
    fallbacks: [],
  };
  const researchCoverage = buildResearchCoverage(
    new Set(snap.dataAvailability.available),
    new Set(
      Object.entries(snap.sourceMetadata ?? {})
        .filter(([, metadata]) => metadata?.freshness?.some((item) => item.stale))
        .map(([field]) => field),
    ),
  );

  // ── citations ───────────────────────────────────────────────────────────
  const citations = snap.citations.map((c) => ({
    title: c.title,
    url: c.url,
    sourceType: toCitationSourceType(c.sourceType),
    retrievedAt: c.retrievedAt,
    ...(c.qualityTier ? { qualityTier: c.qualityTier } : {}),
    ...(c.provider ? { provider: c.provider } : {}),
  }));

  // ── computedFacts passthrough (Wave 1.2 field) ──────────────────────────
  const computedFacts: ComputedFactsBlock = {
    ratios: snap.computedFacts.financialRatios,
    technical: snap.computedFacts.technicalIndicators,
    valuation: snap.computedFacts.valuation,
    peerComparison: snap.computedFacts.peerComparison,
    historicalContext: snap.computedFacts.historicalContext,
    redFlags: snap.computedFacts.redFlags,
    warnings: snap.dataAvailability.warnings.map((w) => ({
      code: 'compute_warning',
      metric: '',
      detail: w,
    })),
  };

  // ── envelope ────────────────────────────────────────────────────────────
  const pack: EvidencePackV2 = {
    schemaVersion: 'evidence-pack-v2',
    symbol: snap.symbol,
    market: snap.market as EvidencePackMarket,
    capturedAt: snap.capturedAt,
    facts,
    dataAvailability: availability,
    citations,
    trace: {
      durationMs: 0,
      toolCalls: 0,
      costUsd: 0,
      ...(opts.snapshotId ? { snapshotId: opts.snapshotId } : {}),
      ...(opts.planId ? { planId: opts.planId } : {}),
      originCounts: {
        fromSnapshot: Object.keys(facts).length,
        providerNative: 0,
      },
      augmentedFactKeys: [],
      snapshotFactMapping: [],
    },
    systemContext: {
      confidenceCap: researchCoverage.overallConfidenceCap,
      minimumViable: researchCoverage.overallStatus !== 'INSUFFICIENT_EVIDENCE',
      planDisclaimer: [
        `研究数据覆盖状态: ${researchCoverage.overallStatus}`,
        '未满足最低事实的维度会被降级或跳过；不得以网搜结果替代结构化核心数据。',
      ],
      blockedClaims: [],
      degradedReasons: Object.values(researchCoverage.dimensions)
        .filter((decision) => decision.status !== 'PASS')
        .map((decision) => `${decision.sectionType}: ${decision.missingCriticalFacts.join(', ')}`),
      skippedSlots: Object.values(researchCoverage.dimensions)
        .filter((decision) => !decision.minimumViable)
        .flatMap((decision) => decision.missingCriticalFacts.map((field) => ({
          slot: `${decision.sectionType}.${field}`,
          reason: 'required fact unavailable in this snapshot',
          priority: 'critical' as const,
        }))),
    },
    researchCoverage,
    computedFacts,
  };

  return pack;
}

function isStockConnectObservation(
  value: OwnershipObservation,
): value is Extract<OwnershipObservation, { kind: 'STOCK_CONNECT' }> {
  return value.kind === 'STOCK_CONNECT';
}

function isStockConnectHoldingObservation(
  value: OwnershipObservation,
): value is Extract<OwnershipObservation, { kind: 'STOCK_CONNECT_HOLDING' }> {
  return value.kind === 'STOCK_CONNECT_HOLDING';
}

function isLhbEvent(value: MarketEvent): value is Extract<MarketEvent, { type: 'LHB' }> {
  return value.type === 'LHB';
}

function isUnlockEvent(value: MarketEvent): value is Extract<MarketEvent, { type: 'UNLOCK' }> {
  return value.type === 'UNLOCK';
}

// ============================================================================
// Helpers
// ============================================================================

function indexCitationsByField(
  snap: StockSnapshot,
): Map<string, StockSnapshot['citations'][number]> {
  const m = new Map<string, StockSnapshot['citations'][number]>();
  for (const c of snap.citations) {
    if (!m.has(c.factKey)) m.set(c.factKey, c);
  }
  return m;
}

function pickFinancialsTier(b: FinancialsBundle | null | undefined): SourceTier {
  if (!b) return DEFAULT_TIER;
  // FinancialsBundle.qualityTier is the authoritative source tier
  const t = b.qualityTier;
  if (t === 'A' || t === 'B' || t === 'C' || t === 'D' || t === 'E') return t;
  return DEFAULT_TIER;
}

function toCitationSourceType(
  sourceType: string | undefined,
): 'NEWS' | 'FILING' | 'RESEARCH' | 'DATA_PROVIDER' | 'SOCIAL' | 'OTHER' {
  switch (sourceType) {
    case 'NEWS':
      return 'NEWS';
    case 'FILING':
      return 'FILING';
    case 'RESEARCH':
      return 'RESEARCH';
    case 'SOCIAL':
      return 'SOCIAL';
    case 'PRICE':
    case 'MACRO':
      return 'DATA_PROVIDER';
    default:
      return 'OTHER';
  }
}

function projectWebDocuments(raw: unknown): Array<{
  title: string;
  url: string;
  publishedAt?: string;
  sourceType?: 'web' | 'news' | 'filing';
}> {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const documents: Array<{
    title: string;
    url: string;
    publishedAt?: string;
    sourceType?: 'web' | 'news' | 'filing';
  }> = [];

  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    if (typeof record.url !== 'string' || !isHttpUrl(record.url) || seen.has(record.url)) {
      continue;
    }
    const title = typeof record.title === 'string' && record.title.trim()
      ? record.title.trim()
      : record.url;
    const publishedAt = normalizeIsoDate(record.publishedAt);
    const sourceType = toWebDocumentSourceType(record.sourceType);
    documents.push({
      title,
      url: record.url,
      ...(publishedAt ? { publishedAt } : {}),
      ...(sourceType ? { sourceType } : {}),
    });
    seen.add(record.url);
  }
  return documents;
}

function toWebDocumentSourceType(
  sourceType: unknown,
): 'web' | 'news' | 'filing' | undefined {
  if (sourceType === 'NEWS' || sourceType === 'news') return 'news';
  if (sourceType === 'FILING' || sourceType === 'filing') return 'filing';
  if (sourceType === 'WEB' || sourceType === 'web') return 'web';
  return undefined;
}

function normalizeIsoDate(value: unknown): string | undefined {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) return undefined;
  return new Date(value).toISOString();
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

function extractFilingUrl(f: unknown): string | null {
  if (!f || typeof f !== 'object') return null;
  const o = f as Record<string, unknown>;
  if (typeof o.url === 'string') return o.url;
  if (typeof o.documentUrl === 'string') return o.documentUrl;
  if (typeof o.filingUrl === 'string') return o.filingUrl;
  if (typeof o.htmlUrl === 'string') return o.htmlUrl;
  return null;
}
