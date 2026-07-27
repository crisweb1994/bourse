import { describe, expect, it } from 'vitest';
import type { Quote } from '../..';
import { snapshotToEvidencePack } from '../to-evidence-pack';
import type { StockSnapshot } from '../types';

// ============================================================================
// Builders
// ============================================================================

const RETRIEVED_AT = '2025-05-25T15:00:00.000Z';
const QUOTE_AS_OF = '2025-05-25T00:00:00.000Z';

function defaultCitations(): StockSnapshot['citations'] {
  return [
    {
      factKey: 'quote',
      title: 'Yahoo Finance: AAPL',
      url: 'https://finance.yahoo.com/quote/AAPL',
      asOf: QUOTE_AS_OF,
      retrievedAt: RETRIEVED_AT,
      provider: 'yahoo-finance',
      sourceType: 'PRICE',
      qualityTier: 'B',
    },
    {
      factKey: 'financials',
      title: 'SEC EDGAR: AAPL company filings',
      url: 'https://www.sec.gov/cgi-bin/browse-edgar?CIK=AAPL',
      asOf: '2025-03-31T00:00:00.000Z',
      retrievedAt: RETRIEVED_AT,
      provider: 'sec-edgar',
      sourceType: 'FILING',
      qualityTier: 'A',
    },
    {
      factKey: 'filings',
      title: 'SEC EDGAR: AAPL filings',
      url: 'https://www.sec.gov/cgi-bin/browse-edgar?CIK=AAPL',
      retrievedAt: RETRIEVED_AT,
      provider: 'sec-edgar',
      sourceType: 'FILING',
      qualityTier: 'A',
    },
    {
      factKey: 'consensusEps',
      title: 'Eastmoney analyst estimates',
      url: 'https://data.eastmoney.com/report/600519.html',
      retrievedAt: RETRIEVED_AT,
      provider: 'eastmoney',
      sourceType: 'DATA_PROVIDER',
      qualityTier: 'B',
    },
    {
      factKey: 'northboundFlow',
      title: 'Eastmoney northbound holdings',
      url: 'https://data.eastmoney.com/hsgtcg/StockHdDetail.html?code=600519&market=1',
      retrievedAt: RETRIEVED_AT,
      provider: 'eastmoney',
      sourceType: 'DATA_PROVIDER',
      qualityTier: 'B',
    },
    {
      factKey: 'lhb',
      title: 'Eastmoney Dragon and Tiger List',
      url: 'https://data.eastmoney.com/stock/lhb/600519.html',
      retrievedAt: RETRIEVED_AT,
      provider: 'eastmoney',
      sourceType: 'DATA_PROVIDER',
      qualityTier: 'B',
    },
    {
      factKey: 'unlockCalendar',
      title: 'Eastmoney restricted-share unlock calendar',
      url: 'https://data.eastmoney.com/dxf/detail/600519.html',
      retrievedAt: RETRIEVED_AT,
      provider: 'eastmoney',
      sourceType: 'DATA_PROVIDER',
      qualityTier: 'B',
    },
  ];
}

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

function baseSnapshot(overrides: Partial<StockSnapshot> = {}): StockSnapshot {
  return {
    symbol: 'AAPL',
    market: 'US',
    capturedAt: RETRIEVED_AT,
    rawFacts: {
      quote: null,
      history: null,
      profile: null,
      financials: null,
      filings: null,
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
    citations: defaultCitations(),
    dataAvailability: { available: [], missing: [], warnings: [] },
    ...overrides,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('snapshotToEvidencePack · core fact projection', () => {
  it('emits schemaVersion + symbol + market + capturedAt', () => {
    const pack = snapshotToEvidencePack(baseSnapshot());
    expect(pack.schemaVersion).toBe('evidence-pack-v2');
    expect(pack.symbol).toBe('AAPL');
    expect(pack.market).toBe('US');
    expect(pack.capturedAt).toBe('2025-05-25T15:00:00.000Z');
    expect(pack.researchCoverage?.overallStatus).toBe('INSUFFICIENT_EVIDENCE');
    expect(pack.systemContext?.confidenceCap).toBe('LOW');
  });

  it('extracts quote → facts.quote + marketCap + currency + pe', () => {
    const snap = baseSnapshot({
      rawFacts: { ...baseSnapshot().rawFacts, quote: aaplQuote() },
    });
    const pack = snapshotToEvidencePack(snap);
    expect(pack.facts.quote?.value).toBe(200);
    expect(pack.facts.marketCap?.value).toBe(600_000_000_000);
    expect(pack.facts.currency?.value).toBe('USD');
    expect(pack.facts.pe?.value).toBeCloseTo(28.5);
    // Provenance comes from the connector citation, not the snapshot clock.
    expect(pack.facts.quote?.asOf).toBe(QUOTE_AS_OF);
    expect(pack.facts.quote?.retrievedAt).toBe(RETRIEVED_AT);
    expect(pack.facts.quote?.origin).toBe('from_snapshot');
  });

  it('skips PE when peRatio is missing on quote', () => {
    const q = aaplQuote();
    delete q.peRatio;
    const snap = baseSnapshot({
      rawFacts: { ...baseSnapshot().rawFacts, quote: q },
    });
    const pack = snapshotToEvidencePack(snap);
    expect(pack.facts.quote?.value).toBe(200);
    expect(pack.facts.pe).toBeUndefined();
  });

  it('skips marketCap when price exists but marketCap missing', () => {
    const q = aaplQuote();
    delete q.marketCap;
    const snap = baseSnapshot({
      rawFacts: { ...baseSnapshot().rawFacts, quote: q },
    });
    const pack = snapshotToEvidencePack(snap);
    expect(pack.facts.quote?.value).toBe(200);
    expect(pack.facts.marketCap).toBeUndefined();
  });
});

describe('snapshotToEvidencePack · CN-only facts', () => {
  it('projects consensusEps from Eastmoney-shape payload', () => {
    const snap = baseSnapshot({
      rawFacts: {
        ...baseSnapshot().rawFacts,
        consensusEps: {
          forecasts: [
            { year: 2025, value: 10 },
            { year: 2026, value: 12 },
          ],
        },
      },
    });
    const pack = snapshotToEvidencePack(snap);
    expect(pack.facts.consensusEps?.value).toHaveLength(2);
    expect(pack.facts.consensusEps?.value?.[0]).toEqual({ year: 2025, value: 10 });
  });

  it('projects northboundFlow rows tolerating both .rows wrapper and bare array', () => {
    const wrapped = baseSnapshot({
      rawFacts: {
        ...baseSnapshot().rawFacts,
        northboundFlow: {
          rows: [{ date: '2026-05-22', hgt: 5.5, sgt: 0 }],
        },
      },
    });
    expect(snapshotToEvidencePack(wrapped).facts.northboundFlow?.value).toHaveLength(1);

    const bare = baseSnapshot({
      rawFacts: {
        ...baseSnapshot().rawFacts,
        northboundFlow: [{ date: '2026-05-22', hgt: 5.5, sgt: 0 }],
      },
    });
    expect(snapshotToEvidencePack(bare).facts.northboundFlow?.value).toHaveLength(1);
  });

  it('projects LHB appearances using legacy topBuySeatNames (Wave 1.9)', () => {
    const snap = baseSnapshot({
      rawFacts: {
        ...baseSnapshot().rawFacts,
        lhb: {
          appearances: [
            {
              date: '2026-05-10',
              reason: '换手率达20%',
              // Rich seat objects (Wave 1.5 shape)
              topBuySeats: [
                { name: '国泰君安上海江苏路', buyAmount: 1e7, sellAmount: 0, netAmount: 1e7 },
              ],
              topSellSeats: [],
              // Legacy view (Wave 1.9)
              topBuySeatNames: ['国泰君安上海江苏路'],
              topSellSeatNames: [],
            },
          ],
        },
      },
    });
    const pack = snapshotToEvidencePack(snap);
    const row = pack.facts.lhbAppearances?.value?.[0];
    expect(row?.date).toBe('2026-05-10');
    expect(row?.topBuySeats).toEqual(['国泰君安上海江苏路']);
    expect(row?.topSellSeats).toEqual([]);
  });

  it('projects unlockCalendar events from .events wrapper', () => {
    const snap = baseSnapshot({
      rawFacts: {
        ...baseSnapshot().rawFacts,
        unlockCalendar: {
          events: [
            { date: '2026-06-15', shares: 5_000_000, marketValue: 1.2, type: '首发原股东限售股' },
          ],
        },
      },
    });
    const pack = snapshotToEvidencePack(snap);
    expect(pack.facts.unlockCalendar?.value).toHaveLength(1);
    expect(pack.facts.unlockCalendar?.value?.[0]?.shares).toBe(5_000_000);
  });
});

describe('snapshotToEvidencePack · computedFacts passthrough', () => {
  it('forwards ratios / technical / redFlags / valuation untouched', () => {
    const snap = baseSnapshot({
      computedFacts: {
        financialRatios: { pe: 28.5 } as never, // partial fixture for shape check
        technicalIndicators: { rsi14: 65 } as never,
        valuation: { marketCap: 600e9 } as never,
        peerComparison: null,
        historicalContext: [],
        redFlags: [
          {
            rule: 'fcf_ni_divergence',
            severity: 'high',
            category: 'cash_flow',
            title: 'FCF negative',
            description: '...',
            evidence: {},
          },
        ],
      },
    });
    const pack = snapshotToEvidencePack(snap);
    expect(pack.computedFacts?.ratios).toEqual({ pe: 28.5 });
    expect(pack.computedFacts?.technical).toEqual({ rsi14: 65 });
    expect(pack.computedFacts?.redFlags).toHaveLength(1);
    expect(pack.computedFacts?.valuation).toEqual({ marketCap: 600e9 });
  });

  it('lifts dataAvailability.warnings into computedFacts.warnings', () => {
    const snap = baseSnapshot({
      dataAvailability: {
        available: ['quote'],
        missing: [],
        warnings: ['missing_data/financials: bundle absent'],
      },
    });
    const pack = snapshotToEvidencePack(snap);
    expect(pack.computedFacts?.warnings).toHaveLength(1);
    expect(pack.computedFacts?.warnings[0]?.detail).toBe(
      'missing_data/financials: bundle absent',
    );
  });
});

describe('snapshotToEvidencePack · macro and web research', () => {
  it('projects Tavily documents and official macro observations with their own sources', () => {
    const snap = baseSnapshot({
      rawFacts: {
        ...baseSnapshot().rawFacts,
        webSearch: [
          {
            title: 'Apple reports quarterly results',
            url: 'https://www.apple.com/newsroom/2025/05/apple-reports-quarterly-results/',
            publishedAt: '2025-05-01',
            sourceType: 'NEWS',
          },
        ],
        macro: {
          market: 'US',
          observations: [
            {
              indicator: 'policy_rate',
              value: 4.5,
              unit: 'percent',
              period: '2025-05-01',
              frequency: 'MONTHLY',
              provider: 'fred',
              seriesId: 'FEDFUNDS',
            },
          ],
        },
      },
      citations: [
        ...defaultCitations(),
        {
          factKey: 'webSearch',
          title: 'Apple quarterly-results search',
          url: 'https://www.apple.com/newsroom/2025/05/apple-reports-quarterly-results/',
          retrievedAt: RETRIEVED_AT,
          provider: 'tavily',
          sourceType: 'NEWS',
          qualityTier: 'D',
        },
        {
          factKey: 'macro',
          title: 'FRED: Federal Funds Effective Rate',
          url: 'https://fred.stlouisfed.org/series/FEDFUNDS',
          asOf: '2025-05-01T00:00:00.000Z',
          retrievedAt: RETRIEVED_AT,
          provider: 'fred',
          sourceType: 'MACRO',
          qualityTier: 'A',
        },
      ],
    });

    const pack = snapshotToEvidencePack(snap);
    expect(pack.facts.webDocuments?.value).toEqual([
      {
        title: 'Apple reports quarterly results',
        url: 'https://www.apple.com/newsroom/2025/05/apple-reports-quarterly-results/',
        publishedAt: '2025-05-01T00:00:00.000Z',
        sourceType: 'news',
      },
    ]);
    expect(pack.facts.recentNews?.value).toHaveLength(1);
    expect(pack.facts.macro?.value.observations[0]?.seriesId).toBe('FEDFUNDS');
    expect(pack.facts.macro?.sourceTier).toBe('A');
  });
});

describe('snapshotToEvidencePack · dataAvailability mapping', () => {
  it('maps missing entries to {field, reason} (concatenating detail)', () => {
    const snap = baseSnapshot({
      dataAvailability: {
        available: ['quote', 'financials'],
        missing: [
          { field: 'history', reason: 'connector_error', detail: 'HTTP 500' },
          { field: 'consensusEps', reason: 'not_configured' },
        ],
        warnings: [],
      },
    });
    const pack = snapshotToEvidencePack(snap);
    expect(pack.dataAvailability.complete).toEqual(['quote', 'financials']);
    expect(pack.dataAvailability.missing).toEqual([
      { field: 'history', reason: 'connector_error: HTTP 500' },
      { field: 'consensusEps', reason: 'not_configured' },
    ]);
  });
});

describe('snapshotToEvidencePack · trace metadata', () => {
  it('counts originCounts.fromSnapshot as the number of populated facts', () => {
    const snap = baseSnapshot({
      rawFacts: { ...baseSnapshot().rawFacts, quote: aaplQuote() },
    });
    const pack = snapshotToEvidencePack(snap);
    // quote contributes 4 facts: quote, marketCap, currency, pe
    expect(pack.trace.originCounts?.fromSnapshot).toBe(4);
    expect(pack.trace.originCounts?.providerNative).toBe(0);
  });

  it('stamps planId + snapshotId from options when provided', () => {
    const pack = snapshotToEvidencePack(baseSnapshot(), {
      planId: 'plan-xyz',
      snapshotId: 'snap-abc',
    });
    expect(pack.trace.planId).toBe('plan-xyz');
    expect(pack.trace.snapshotId).toBe('snap-abc');
  });
});

describe('snapshotToEvidencePack · citation routing', () => {
  it('uses snapshot.citations[].url for matching factKey', () => {
    const snap = baseSnapshot({
      rawFacts: { ...baseSnapshot().rawFacts, quote: aaplQuote() },
      citations: [
        {
          factKey: 'quote',
          title: 'Yahoo',
          url: 'https://finance.yahoo.com/quote/AAPL',
          retrievedAt: '2025-05-25T15:00:00.000Z',
        },
      ],
    });
    const pack = snapshotToEvidencePack(snap);
    expect(pack.facts.quote?.sourceUrl).toBe('https://finance.yahoo.com/quote/AAPL');
  });

  it('omits a fact when no verifiable citation matches', () => {
    const snap = baseSnapshot({
      rawFacts: { ...baseSnapshot().rawFacts, quote: aaplQuote() },
      citations: [],
    });
    const pack = snapshotToEvidencePack(snap);
    expect(pack.facts.quote).toBeUndefined();
    expect(pack.facts.marketCap).toBeUndefined();
    expect(pack.facts.currency).toBeUndefined();
    expect(pack.facts.pe).toBeUndefined();
  });
});
