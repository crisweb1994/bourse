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
 *  - rawFacts.lhb → facts.lhbAppearances (project rich seat objects to
 *    legacy name list per Wave 1.9)
 *  - rawFacts.unlockCalendar → facts.unlockCalendar
 *  - rawFacts.shareholders → facts.shareholderConcentration (derive top10
 *    from holderTotalNum stats; emit `null` when shape unknown)
 *  - computedFacts → pack.computedFacts (Wave 1.2 field, byte passthrough)
 *
 * Provenance:
 *  - sourceUrl pulled from snapshot.citations matching by factKey when
 *    available; otherwise a synthetic "snapshot://<symbol>/<field>" URL
 *  - asOf + retrievedAt = snapshot.capturedAt (pack-level provenance per
 *    plan-v2 invariant #4)
 *  - sourceTier = 'B' default (snapshot loses per-field tier; future
 *    iterations can thread tier through citations)
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
import type { FinancialsBundle } from '../ports/financials';
import type { StockSnapshot } from './types';

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
  const provenance = {
    asOf: snap.capturedAt,
    retrievedAt: snap.capturedAt,
    sourceTier: DEFAULT_TIER,
    origin: 'from_snapshot' as const,
  };

  const citationByField = indexCitationsByField(snap);
  const sourceUrlFor = (field: string): string =>
    citationByField.get(field)?.url ?? `snapshot://${snap.symbol}/${field}`;

  const mkFact = <T>(field: string, value: T, extra?: Partial<FactOf<T>>): FactOf<T> => ({
    value,
    ...provenance,
    sourceUrl: sourceUrlFor(field),
    ...(extra ?? {}),
  });

  // ── facts construction ──────────────────────────────────────────────────
  const facts: EvidencePackV2['facts'] = {};

  // Quote → quote / marketCap / currency / pe
  const q = snap.rawFacts.quote;
  if (q) {
    if (q.price > 0) facts.quote = mkFact('quote', q.price, { unit: q.currency });
    if (q.marketCap !== undefined && q.marketCap > 0) {
      facts.marketCap = mkFact('quote', q.marketCap, {
        currency: q.currency,
      });
    }
    if (typeof q.currency === 'string' && q.currency.length === 3) {
      facts.currency = mkFact('quote', q.currency);
    }
    if (q.peRatio !== undefined && Number.isFinite(q.peRatio)) {
      facts.pe = mkFact('quote', q.peRatio);
    }
  }

  // Profile → facts.profile (Yahoo assetProfile / Eastmoney F10 基本资料).
  // The connector emits a CompanyProfile object (with an `instrument` field we
  // drop here); project the descriptive scalars. Tier B (vendor F10 / Yahoo
  // profile, not a primary regulatory filing).
  const prof = snap.rawFacts.profile;
  if (prof && typeof prof === 'object') {
    const p = prof as Record<string, unknown>;
    const value: Record<string, unknown> = {};
    if (typeof p.description === 'string' && p.description) value.description = p.description;
    if (typeof p.sector === 'string' && p.sector) value.sector = p.sector;
    if (typeof p.industry === 'string' && p.industry) value.industry = p.industry;
    if (typeof p.employees === 'number' && Number.isFinite(p.employees)) value.employees = p.employees;
    if (typeof p.website === 'string' && p.website) value.website = p.website;
    if (typeof p.marketCap === 'number' && Number.isFinite(p.marketCap)) value.marketCap = p.marketCap;
    if (Object.keys(value).length > 0) {
      facts.profile = mkFact('profile', value);
    }
  }

  // Financials passthrough
  if (snap.rawFacts.financials) {
    facts.financials = mkFact('financials', snap.rawFacts.financials as FinancialsBundle, {
      sourceTier: pickFinancialsTier(snap.rawFacts.financials),
    });
  }

  // Filings → latestFilingUrls
  if (snap.rawFacts.filings && Array.isArray(snap.rawFacts.filings)) {
    const urls = snap.rawFacts.filings
      .map((f) => extractFilingUrl(f))
      .filter((u): u is string => typeof u === 'string' && u.length > 0)
      .slice(0, 10);
    if (urls.length > 0) {
      facts.latestFilingUrls = mkFact('filings', urls);
    }
  }

  // consensusEps — recognize Eastmoney-shape {forecasts:[{year,value}]}
  const ce = snap.rawFacts.consensusEps;
  if (ce && typeof ce === 'object' && Array.isArray((ce as { forecasts?: unknown }).forecasts)) {
    const forecasts = (ce as { forecasts: Array<{ year: unknown; value: unknown }> }).forecasts
      .filter(
        (f) => typeof f.year === 'number' && typeof f.value === 'number',
      )
      .map((f) => ({ year: f.year as number, value: f.value as number }));
    if (forecasts.length > 0) {
      facts.consensusEps = mkFact('consensusEps', forecasts);
    }
  }

  // northboundFlow — expect Array<{date, hgt, sgt}>
  const nbf = snap.rawFacts.northboundFlow;
  if (nbf && Array.isArray((nbf as { rows?: unknown }).rows)) {
    const rows = (nbf as { rows: Array<{ date: unknown; hgt: unknown; sgt: unknown }> }).rows
      .filter(
        (r) =>
          typeof r.date === 'string' &&
          typeof r.hgt === 'number' &&
          typeof r.sgt === 'number',
      )
      .map((r) => ({
        date: r.date as string,
        hgt: r.hgt as number,
        sgt: r.sgt as number,
      }));
    if (rows.length > 0) {
      facts.northboundFlow = mkFact('northboundFlow', rows);
    }
  } else if (Array.isArray(nbf)) {
    // Bare array shape (legacy callers)
    const rows = (nbf as Array<{ date: unknown; hgt: unknown; sgt: unknown }>)
      .filter(
        (r) =>
          r && typeof r === 'object' &&
          typeof r.date === 'string' &&
          typeof r.hgt === 'number' &&
          typeof r.sgt === 'number',
      )
      .map((r) => ({
        date: r.date as string,
        hgt: r.hgt as number,
        sgt: r.sgt as number,
      }));
    if (rows.length > 0) {
      facts.northboundFlow = mkFact('northboundFlow', rows);
    }
  }

  // LHB — Wave 1.5 emits rich seats; project to legacy name list (Wave 1.9)
  const lhb = snap.rawFacts.lhb;
  if (lhb && typeof lhb === 'object' && Array.isArray((lhb as { appearances?: unknown }).appearances)) {
    const apps = (lhb as {
      appearances: Array<{
        date?: unknown;
        reason?: unknown;
        topBuySeatNames?: unknown;
        topSellSeatNames?: unknown;
      }>;
    }).appearances
      .filter((a) => typeof a.date === 'string' && typeof a.reason === 'string')
      .map((a) => ({
        date: a.date as string,
        reason: a.reason as string,
        topBuySeats: Array.isArray(a.topBuySeatNames)
          ? (a.topBuySeatNames as unknown[]).filter((s): s is string => typeof s === 'string')
          : [],
        topSellSeats: Array.isArray(a.topSellSeatNames)
          ? (a.topSellSeatNames as unknown[]).filter((s): s is string => typeof s === 'string')
          : [],
      }));
    if (apps.length > 0) {
      facts.lhbAppearances = mkFact('lhb', apps);
    }
  }

  // unlockCalendar — expect Array<{date, shares, marketValue?, type}>
  const uc = snap.rawFacts.unlockCalendar;
  if (uc && typeof uc === 'object' && Array.isArray((uc as { events?: unknown }).events)) {
    const events = (uc as {
      events: Array<{ date: unknown; shares: unknown; marketValue?: unknown; type?: unknown }>;
    }).events
      .filter(
        (e) =>
          typeof e.date === 'string' &&
          typeof e.shares === 'number' &&
          e.shares > 0,
      )
      .map((e) => ({
        date: e.date as string,
        shares: e.shares as number,
        ...(typeof e.marketValue === 'number' ? { marketValue: e.marketValue as number } : {}),
        type: typeof e.type === 'string' ? (e.type as string) : 'unknown',
      }));
    if (events.length > 0) {
      facts.unlockCalendar = mkFact('unlockCalendar', events);
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
  if (sh && typeof sh === 'object' && Array.isArray((sh as { rows?: unknown }).rows)) {
    const rows = (sh as { rows: Array<Record<string, unknown>> }).rows;
    if (rows.length > 0) {
      // The legacy ShareholderConcentration schema requires top10Ratio
      // (number 0-1). We can't fabricate it from holder-count data, so
      // we skip the fact rather than emit a wrong value. Surface in
      // dataAvailability instead so prompts know the data exists in
      // raw form on the snapshot.
      // (Future: shareholders connector should expose top10 ratio when
      // RPT_F10_EH_FREEHOLDERS or similar is wired.)
      void rows;
    }
  }

  // ── dataAvailability ────────────────────────────────────────────────────
  const availability: EvidencePackDataAvailability = {
    complete: snap.dataAvailability.available,
    missing: snap.dataAvailability.missing.map((m) => ({
      field: m.field,
      reason: m.detail ? `${m.reason}: ${m.detail}` : m.reason,
    })),
    fallbacks: [],
  };

  // ── citations ───────────────────────────────────────────────────────────
  const citations = snap.citations.map((c) => ({
    title: c.title,
    url: c.url,
    sourceType: 'OTHER' as const,
    retrievedAt: c.retrievedAt,
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
    computedFacts,
  };

  return pack;
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

function extractFilingUrl(f: unknown): string | null {
  if (!f || typeof f !== 'object') return null;
  const o = f as Record<string, unknown>;
  if (typeof o.url === 'string') return o.url;
  if (typeof o.documentUrl === 'string') return o.documentUrl;
  if (typeof o.filingUrl === 'string') return o.filingUrl;
  if (typeof o.htmlUrl === 'string') return o.htmlUrl;
  return null;
}
