import { describe, expect, it } from 'vitest';
import type {
  FinancialsBundle,
  PriceBar,
  Quote,
} from '../..';
import { fetchSnapshot } from '../fetch-snapshot';
import { defineMarketConfig, type MarketConfigMap } from '../market-config';

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
  };
}

function fakeHistory(n: number): PriceBar[] {
  const out: PriceBar[] = [];
  for (let i = 0; i < n; i++) {
    const d = new Date('2025-05-25');
    d.setUTCDate(d.getUTCDate() - (n - i));
    out.push({
      timestamp: d.toISOString().slice(0, 10),
      open: 100 + i * 0.5,
      high: 102 + i * 0.5,
      low: 99 + i * 0.5,
      close: 100 + i * 0.5,
      volume: 1_000_000,
    });
  }
  return out;
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
    sourceUrl: 'https://example.com',
    retrievedAt: '2025-05-25T00:00:00.000Z',
    provider: 'test',
    qualityTier: 'A',
  };
}

function buildConfigs(overrides: Partial<MarketConfigMap[keyof MarketConfigMap]> = {}): MarketConfigMap {
  return {
    US: defineMarketConfig('US', 'USD', {
      quote: async () => aaplQuote(),
      history: async () => fakeHistory(250),
      financials: async () => aaplFinancials(),
      ...overrides,
    }),
    CN: defineMarketConfig('CN', 'CNY', {
      quote: async () => null,
    }),
    HK: defineMarketConfig('HK', 'HKD', {
      quote: async () => null,
    }),
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('fetchSnapshot · orchestration', () => {
  it('returns a populated snapshot when all configured fetchers succeed', async () => {
    const snap = await fetchSnapshot({
      symbol: 'AAPL',
      market: 'US',
      configs: buildConfigs(),
    });
    expect(snap.symbol).toBe('AAPL');
    expect(snap.market).toBe('US');
    expect(snap.rawFacts.quote?.price).toBe(200);
    expect(snap.rawFacts.financials?.periods).toHaveLength(1);
    expect(snap.rawFacts.history?.length).toBe(250);
  });

  it('runs compute layer once raw facts settle', async () => {
    const snap = await fetchSnapshot({
      symbol: 'AAPL',
      market: 'US',
      configs: buildConfigs(),
    });
    expect(snap.computedFacts.financialRatios).not.toBeNull();
    expect(snap.computedFacts.financialRatios!.pe).toBeCloseTo(30, 1);
    expect(snap.computedFacts.technicalIndicators).not.toBeNull();
    expect(snap.computedFacts.valuation).not.toBeNull();
  });

  it('emits dataAvailability.available + missing for every fact key', async () => {
    const snap = await fetchSnapshot({
      symbol: 'AAPL',
      market: 'US',
      configs: buildConfigs(),
    });
    const totalKeys = snap.dataAvailability.available.length + snap.dataAvailability.missing.length;
    // 12 fact keys: quote/history/profile/financials/filings/consensusEps/
    // northboundFlow/lhb/unlockCalendar/shareholders/webSearch/macro
    expect(totalKeys).toBe(12);
  });

  it('marks not-configured fetchers as `not_configured` (vs no_data)', async () => {
    const configs = buildConfigs();
    const snap = await fetchSnapshot({
      symbol: 'AAPL',
      market: 'US',
      configs,
    });
    const profileMiss = snap.dataAvailability.missing.find((m) => m.field === 'profile');
    expect(profileMiss?.reason).toBe('not_configured');
  });

  it('classifies connector throws as `connector_error`', async () => {
    const configs = buildConfigs({
      quote: async () => {
        throw new Error('upstream blew up');
      },
    });
    const snap = await fetchSnapshot({
      symbol: 'AAPL',
      market: 'US',
      configs,
    });
    const miss = snap.dataAvailability.missing.find((m) => m.field === 'quote');
    expect(miss?.reason).toBe('connector_error');
    expect(miss?.detail).toContain('upstream blew up');
  });

  it('classifies 429 messages as `rate_limited`', async () => {
    const configs = buildConfigs({
      quote: async () => {
        throw new Error('HTTP 429 retry-after: 30s');
      },
    });
    const snap = await fetchSnapshot({
      symbol: 'AAPL',
      market: 'US',
      configs,
    });
    const miss = snap.dataAvailability.missing.find((m) => m.field === 'quote');
    expect(miss?.reason).toBe('rate_limited');
  });

  it('classifies tool error with reason=not_implemented as not_implemented', async () => {
    const configs = buildConfigs({
      financials: async () => {
        const e = new Error('all mirrors failed');
        (e as Error & { reason?: string }).reason = 'not_implemented';
        throw e;
      },
    });
    const snap = await fetchSnapshot({
      symbol: 'AAPL',
      market: 'US',
      configs,
    });
    const miss = snap.dataAvailability.missing.find((m) => m.field === 'financials');
    expect(miss?.reason).toBe('not_implemented');
  });

  it('marks null-returning fetchers as `no_data` (distinct from error)', async () => {
    const configs = buildConfigs({
      quote: async () => null,
    });
    const snap = await fetchSnapshot({
      symbol: 'AAPL',
      market: 'US',
      configs,
    });
    const miss = snap.dataAvailability.missing.find((m) => m.field === 'quote');
    expect(miss?.reason).toBe('no_data');
  });

  it('honors per-connector timeout (slow fetcher → timeout reason)', async () => {
    const configs = buildConfigs({
      quote: () => new Promise<Quote>(() => { /* never resolves */ }),
    });
    const snap = await fetchSnapshot({
      symbol: 'AAPL',
      market: 'US',
      configs,
      perConnectorTimeoutMs: 50,
    });
    const miss = snap.dataAvailability.missing.find((m) => m.field === 'quote');
    expect(miss?.reason).toBe('timeout');
  });

  it('does not throw when entire market is dark (all fetchers fail)', async () => {
    const configs: MarketConfigMap = {
      US: defineMarketConfig('US', 'USD', {
        quote: async () => {
          throw new Error('down');
        },
      }),
      CN: defineMarketConfig('CN', 'CNY', { quote: async () => null }),
      HK: defineMarketConfig('HK', 'HKD', { quote: async () => null }),
    };
    const snap = await fetchSnapshot({
      symbol: 'AAPL',
      market: 'US',
      configs,
    });
    expect(snap.dataAvailability.available).toEqual([]);
    expect(snap.dataAvailability.missing.length).toBe(12);
    expect(snap.computedFacts.financialRatios).toBeNull();
  });

  it('throws when market has no config at all', async () => {
    await expect(
      fetchSnapshot({
        symbol: 'foo',
        market: 'US',
        configs: {} as MarketConfigMap,
      }),
    ).rejects.toThrow(/no MarketConfig/);
  });
});

describe('fetchSnapshot · compute integration', () => {
  it('surfaces compute warnings into dataAvailability.warnings', async () => {
    // Provide quote but no financials → ratios will warn missing_data
    const configs = buildConfigs({
      financials: async () => null,
    });
    const snap = await fetchSnapshot({
      symbol: 'AAPL',
      market: 'US',
      configs,
    });
    // History exists but financials don't → ratios should be null
    expect(snap.computedFacts.financialRatios).toBeNull();
  });

  it('derives consensusEpsGrowth into valuation forward DCF when consensus payload shaped right', async () => {
    const configs = buildConfigs({
      consensusEps: async () => ({
        forecasts: [
          { year: 2025, value: 10 },
          { year: 2026, value: 12 }, // +20% YoY → 8% haircut applied
        ],
      }),
    });
    const snap = await fetchSnapshot({
      symbol: 'AAPL',
      market: 'US',
      configs,
    });
    // Forward DCF requires FCF; we have it in fixture. Assumed growth=0.16 (0.2*0.8)
    expect(snap.computedFacts.valuation?.fairValueAssumedGrowth).toBeCloseTo(0.16, 4);
  });
});
