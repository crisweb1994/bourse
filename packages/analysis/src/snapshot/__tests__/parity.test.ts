/**
 * plan-v2 Wave 2.5 — parity tests.
 *
 * Validates that snapshotToEvidencePack output:
 *   1. Conforms to the EvidencePackV2 zod schema (round-trips through
 *      .parse() without throwing).
 *   2. Carries every field the legacy snapshot-backed wrapper produces
 *      for the same logical inputs (fact coverage regression).
 *   3. Uses correct provenance shape (asOf/retrievedAt/sourceTier/origin)
 *      per plan §1.2 invariant #4.
 *
 * Stays in the analysis package so it doesn't drag in apps/api wiring;
 * inputs are hand-constructed StockSnapshot fixtures.
 */
import { describe, expect, it } from 'vitest';
import { EvidencePackV2 as EvidencePackV2Schema } from '../..';
import type {
  FinancialsBundle,
  PriceBar,
  Quote,
} from '../..';
import { snapshotToEvidencePack } from '../to-evidence-pack';
import type { StockSnapshot } from '../types';

// ============================================================================
// Fixtures
// ============================================================================

function aaplQuote(): Quote {
  return {
    instrument: { instrumentId: 'US:AAPL', market: 'US', symbol: 'AAPL' },
    price: 200,
    currency: 'USD',
    timestamp: '2025-05-25T00:00:00.000Z',
    marketCap: 600_000_000_000,
    peRatio: 28.5,
  };
}

function aaplFinancials(): FinancialsBundle {
  return {
    periods: [
      {
        fiscalPeriod: 'TTM',
        kind: 'TTM',
        fiscalYearEnd: '2025-03-31',
        filed: '2025-04-30',
        income: {
          revenue: { value: 100_000_000_000, unit: 'USD' },
          netIncome: { value: 20_000_000_000, unit: 'USD' },
        },
        balance: {
          totalAssets: { value: 350_000_000_000, unit: 'USD' },
          totalLiabilities: { value: 280_000_000_000, unit: 'USD' },
          totalStockholdersEquity: { value: 70_000_000_000, unit: 'USD' },
        },
        cashFlow: {
          operatingCashFlow: { value: 22_000_000_000, unit: 'USD' },
          freeCashFlow: { value: 18_000_000_000, unit: 'USD' },
        },
      },
    ],
    currency: 'USD',
    sourceUrl: 'https://www.sec.gov/cgi-bin/browse-edgar?CIK=AAPL',
    retrievedAt: '2025-05-25T00:00:00.000Z',
    provider: 'sec-edgar-xbrl',
    qualityTier: 'A',
  };
}

function aaplBars(): PriceBar[] {
  const out: PriceBar[] = [];
  for (let i = 0; i < 250; i++) {
    const d = new Date('2025-05-25');
    d.setUTCDate(d.getUTCDate() - (250 - i));
    out.push({
      timestamp: d.toISOString().slice(0, 10),
      open: 100 + i * 0.4,
      high: 102 + i * 0.4,
      low: 99 + i * 0.4,
      close: 100 + i * 0.4,
      volume: 1_000_000,
    });
  }
  return out;
}

function richSnapshot(): StockSnapshot {
  return {
    symbol: 'AAPL',
    market: 'US',
    capturedAt: '2025-05-25T15:00:00.000Z',
    rawFacts: {
      quote: aaplQuote(),
      history: aaplBars(),
      profile: { sector: 'Technology', industry: 'Consumer Electronics' },
      financials: aaplFinancials(),
      filings: [
        { url: 'https://sec.gov/x.htm', title: '10-Q', type: '10-Q' } as never,
        { url: 'https://sec.gov/y.htm', title: '8-K', type: '8-K' } as never,
      ],
      consensusEps: null,
      northboundFlow: null,
      lhb: null,
      unlockCalendar: null,
      shareholders: null,
      webSearch: null,
      macro: null,
    },
    computedFacts: {
      financialRatios: null,
      technicalIndicators: null,
      redFlags: [],
      valuation: null,
      peerComparison: null,
      historicalContext: [],
    },
    citations: [
      {
        factKey: 'quote',
        title: 'Yahoo AAPL',
        url: 'https://finance.yahoo.com/quote/AAPL',
        retrievedAt: '2025-05-25T15:00:00.000Z',
      },
      {
        factKey: 'financials',
        title: 'SEC AAPL',
        url: 'https://www.sec.gov/cgi-bin/browse-edgar?CIK=AAPL',
        retrievedAt: '2025-05-25T15:00:00.000Z',
      },
    ],
    dataAvailability: {
      available: ['quote', 'history', 'profile', 'financials', 'filings'],
      missing: [
        { field: 'consensusEps', reason: 'not_configured' },
        { field: 'lhb', reason: 'not_configured' },
      ],
      warnings: [],
    },
  };
}

function cnSnapshot(): StockSnapshot {
  return {
    symbol: '600519',
    market: 'CN',
    capturedAt: '2025-05-25T15:00:00.000Z',
    rawFacts: {
      quote: {
        instrument: { instrumentId: 'CN:600519', market: 'CN', symbol: '600519' },
        price: 1685,
        currency: 'CNY',
        timestamp: '2025-05-25T00:00:00.000Z',
        marketCap: 21_000, // 亿元
      },
      history: null,
      profile: null,
      financials: null,
      filings: null,
      consensusEps: {
        forecasts: [
          { year: 2026, value: 68.96 },
          { year: 2027, value: 72.75 },
        ],
      },
      northboundFlow: {
        rows: [
          { date: '2026-05-22', hgt: 5.5, sgt: 0 },
          { date: '2026-05-21', hgt: -3.2, sgt: 0 },
        ],
      },
      lhb: {
        appearances: [
          {
            date: '2026-05-10',
            reason: '换手率达20%',
            topBuySeats: [
              { name: '国泰君安上海江苏路', buyAmount: 1e7, sellAmount: 0, netAmount: 1e7 },
            ],
            topSellSeats: [],
            topBuySeatNames: ['国泰君安上海江苏路'],
            topSellSeatNames: [],
          },
        ],
      },
      unlockCalendar: {
        events: [{ date: '2026-06-15', shares: 5_000_000, type: '首发原股东限售股' }],
      },
      shareholders: { rows: [] },
      webSearch: null,
      macro: null,
    },
    computedFacts: {
      financialRatios: null,
      technicalIndicators: null,
      redFlags: [],
      valuation: null,
      peerComparison: null,
      historicalContext: [],
    },
    citations: [],
    dataAvailability: {
      available: ['quote', 'consensusEps', 'northboundFlow', 'lhb', 'unlockCalendar'],
      missing: [{ field: 'financials', reason: 'no_data' }],
      warnings: ['missing_data/financialRatios: bundle absent'],
    },
  };
}

// ============================================================================
// Schema parity
// ============================================================================

describe('parity · EvidencePackV2 schema conformance', () => {
  it('US pack with quote+financials+history+filings passes EvidencePackV2.parse()', () => {
    const pack = snapshotToEvidencePack(richSnapshot());
    const r = EvidencePackV2Schema.safeParse(pack);
    if (!r.success) {
      console.error('EvidencePackV2 parse errors:', JSON.stringify(r.error.errors, null, 2));
    }
    expect(r.success).toBe(true);
  });

  it('CN pack with all 4 CN-only fact keys passes EvidencePackV2.parse()', () => {
    const pack = snapshotToEvidencePack(cnSnapshot());
    const r = EvidencePackV2Schema.safeParse(pack);
    if (!r.success) {
      console.error('EvidencePackV2 parse errors:', JSON.stringify(r.error.errors, null, 2));
    }
    expect(r.success).toBe(true);
  });

  it('empty snapshot still passes schema (all fields optional)', () => {
    const empty: StockSnapshot = {
      ...richSnapshot(),
      rawFacts: { ...richSnapshot().rawFacts, quote: null, financials: null, filings: null },
    };
    const pack = snapshotToEvidencePack(empty);
    expect(EvidencePackV2Schema.safeParse(pack).success).toBe(true);
  });
});

// ============================================================================
// Fact coverage parity
// ============================================================================

describe('parity · fact coverage (regression guard)', () => {
  it('US: snapshot quote → pack carries quote+marketCap+currency+pe', () => {
    const pack = snapshotToEvidencePack(richSnapshot());
    expect(pack.facts.quote).toBeDefined();
    expect(pack.facts.marketCap).toBeDefined();
    expect(pack.facts.currency).toBeDefined();
    expect(pack.facts.pe).toBeDefined();
  });

  it('US: snapshot financials → pack.financials passthrough with qualityTier preserved', () => {
    const pack = snapshotToEvidencePack(richSnapshot());
    expect(pack.facts.financials?.sourceTier).toBe('A'); // bundle.qualityTier
    expect(pack.facts.financials?.value.periods).toHaveLength(1);
  });

  it('US: snapshot filings → pack.latestFilingUrls (urls only)', () => {
    const pack = snapshotToEvidencePack(richSnapshot());
    expect(pack.facts.latestFilingUrls?.value).toEqual([
      'https://sec.gov/x.htm',
      'https://sec.gov/y.htm',
    ]);
  });

  it('CN: 4 CN-only fact keys (consensusEps/lhb/northbound/unlock) all land', () => {
    const pack = snapshotToEvidencePack(cnSnapshot());
    expect(pack.facts.consensusEps).toBeDefined();
    expect(pack.facts.lhbAppearances).toBeDefined();
    expect(pack.facts.northboundFlow).toBeDefined();
    expect(pack.facts.unlockCalendar).toBeDefined();
  });

  it('CN: lhb projection uses string seats (post-Wave 1.9 schema)', () => {
    const pack = snapshotToEvidencePack(cnSnapshot());
    const row = pack.facts.lhbAppearances?.value?.[0];
    expect(row?.topBuySeats).toEqual(['国泰君安上海江苏路']);
    expect(Array.isArray(row?.topBuySeats) && typeof row!.topBuySeats[0] === 'string').toBe(true);
  });
});

// ============================================================================
// Provenance parity (plan §1.2 invariant #4)
// ============================================================================

describe('parity · provenance', () => {
  it('every fact carries asOf + retrievedAt = snapshot.capturedAt', () => {
    const pack = snapshotToEvidencePack(richSnapshot());
    const facts = pack.facts;
    for (const key of Object.keys(facts) as Array<keyof typeof facts>) {
      const f = facts[key];
      if (!f) continue;
      expect(f.asOf).toBe('2025-05-25T15:00:00.000Z');
      expect(f.retrievedAt).toBe('2025-05-25T15:00:00.000Z');
    }
  });

  it('every fact carries origin = from_snapshot', () => {
    const pack = snapshotToEvidencePack(richSnapshot());
    for (const f of Object.values(pack.facts)) {
      if (!f) continue;
      expect(f.origin).toBe('from_snapshot');
    }
  });

  it('citations from snapshot.citations win the sourceUrl assignment', () => {
    const pack = snapshotToEvidencePack(richSnapshot());
    expect(pack.facts.quote?.sourceUrl).toBe('https://finance.yahoo.com/quote/AAPL');
    expect(pack.facts.financials?.sourceUrl).toBe(
      'https://www.sec.gov/cgi-bin/browse-edgar?CIK=AAPL',
    );
  });

  it('CN pack without snapshot citations uses synthetic snapshot:// URLs', () => {
    const pack = snapshotToEvidencePack(cnSnapshot());
    expect(pack.facts.quote?.sourceUrl).toBe('snapshot://600519/quote');
    expect(pack.facts.consensusEps?.sourceUrl).toBe('snapshot://600519/consensusEps');
  });

  it('dataAvailability.missing preserves reason + detail', () => {
    const snap = richSnapshot();
    snap.dataAvailability.missing.push({
      field: 'history',
      reason: 'rate_limited',
      detail: 'HTTP 429 retry-after: 30s',
    });
    const pack = snapshotToEvidencePack(snap);
    const missHist = pack.dataAvailability.missing.find((m) => m.field === 'history');
    expect(missHist?.reason).toBe('rate_limited: HTTP 429 retry-after: 30s');
  });
});

// ============================================================================
// computedFacts parity (Wave 1.2 field)
// ============================================================================

describe('parity · computedFacts', () => {
  it('computedFacts block is always present (even with all-null content)', () => {
    const pack = snapshotToEvidencePack(richSnapshot());
    expect(pack.computedFacts).toBeDefined();
    expect(pack.computedFacts?.ratios).toBeNull();
    expect(pack.computedFacts?.technical).toBeNull();
    expect(pack.computedFacts?.redFlags).toEqual([]);
  });

  it('compute warnings from snapshot.dataAvailability.warnings lift into block', () => {
    const pack = snapshotToEvidencePack(cnSnapshot());
    expect(pack.computedFacts?.warnings.length).toBeGreaterThan(0);
    expect(pack.computedFacts?.warnings[0]?.code).toBe('compute_warning');
  });
});
