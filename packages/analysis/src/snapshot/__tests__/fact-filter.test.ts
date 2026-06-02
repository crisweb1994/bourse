import { describe, expect, it } from 'vitest';
import {
  projectForDimension,
  projectForFundamental,
  projectForIndustry,
  projectForTechnical,
  projectForValuation,
} from '../fact-filter';
import type { StockSnapshot } from '../types';

function emptySnapshot(overrides: Partial<StockSnapshot> = {}): StockSnapshot {
  return {
    symbol: 'AAPL',
    market: 'US',
    capturedAt: '2025-05-25T00:00:00.000Z',
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

describe('fact-filter · projections are narrow', () => {
  it('FUNDAMENTAL: only quote / financials / profile + ratios + redFlags', () => {
    const view = projectForFundamental(emptySnapshot());
    expect(Object.keys(view.rawFacts).sort()).toEqual(
      ['financials', 'profile', 'quote'].sort(),
    );
    expect(Object.keys(view.computedFacts).sort()).toEqual(
      ['financialRatios', 'redFlags'].sort(),
    );
    expect(view.needsWebSearch).toBe(false);
  });

  it('TECHNICAL: only quote + history + technicalIndicators', () => {
    const view = projectForTechnical(emptySnapshot());
    expect(Object.keys(view.rawFacts).sort()).toEqual(['history', 'quote'].sort());
    expect(Object.keys(view.computedFacts)).toEqual(['technicalIndicators']);
    expect(view.needsWebSearch).toBe(false);
  });

  it('VALUATION: includes peer + historical context', () => {
    const view = projectForValuation(emptySnapshot());
    expect(view.computedFacts.peerComparison).toBeDefined();
    expect(view.computedFacts.historicalContext).toBeDefined();
    expect(view.computedFacts.valuation).toBeDefined();
    expect(view.needsWebSearch).toBe(true);
  });

  it('INDUSTRY: primarily web-search driven, raw facts minimal', () => {
    const view = projectForIndustry(emptySnapshot());
    expect(Object.keys(view.rawFacts)).toEqual(['profile']);
    expect(view.needsWebSearch).toBe(true);
  });
});

describe('fact-filter · dispatch', () => {
  it('projectForDimension routes by name to the right helper', () => {
    const snap = emptySnapshot({
      rawFacts: {
        ...emptySnapshot().rawFacts,
        quote: { instrument: { instrumentId: 'US:T', market: 'US', symbol: 'T' }, price: 1, currency: 'USD', timestamp: '' },
      },
    });
    const fundamental = projectForDimension('FUNDAMENTAL', snap);
    expect(fundamental.rawFacts.quote?.price).toBe(1);

    const technical = projectForDimension('TECHNICAL', snap);
    expect(technical.rawFacts.quote?.price).toBe(1);
    expect((technical.rawFacts as Record<string, unknown>).financials).toBeUndefined();
  });

  it('throws on unknown dimension at runtime (exhaustiveness guard)', () => {
    expect(() =>
      projectForDimension(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        'NONSENSE' as any,
        emptySnapshot(),
      ),
    ).toThrow();
  });
});
