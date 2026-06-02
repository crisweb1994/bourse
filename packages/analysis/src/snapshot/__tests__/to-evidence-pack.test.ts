import { describe, expect, it } from 'vitest';
import type { Quote } from '../..';
import { snapshotToEvidencePack } from '../to-evidence-pack';
import type { StockSnapshot } from '../types';

// ============================================================================
// Builders
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

function baseSnapshot(overrides: Partial<StockSnapshot> = {}): StockSnapshot {
  return {
    symbol: 'AAPL',
    market: 'US',
    capturedAt: '2025-05-25T15:00:00.000Z',
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
    citations: [],
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
    // All facts carry asOf/retrievedAt from snapshot.capturedAt
    expect(pack.facts.quote?.asOf).toBe('2025-05-25T15:00:00.000Z');
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

  it('falls back to synthetic snapshot:// URL when no citation matches', () => {
    const snap = baseSnapshot({
      rawFacts: { ...baseSnapshot().rawFacts, quote: aaplQuote() },
    });
    const pack = snapshotToEvidencePack(snap);
    expect(pack.facts.quote?.sourceUrl).toBe('snapshot://AAPL/quote');
  });
});
