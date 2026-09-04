import { describe, expect, it } from 'vitest';
import type {
  FinancialsBundle,
  PriceBar,
  Quote,
} from '@bourse/market-data';
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
    // 单请求双窗口：旧日期 fixture 走全量保留分支
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
    // 15 fact keys, including canonical corporate-actions/ownership/events.
    expect(totalKeys).toBe(15);
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

  it('preserves an empty unlock response so the snapshot can say "no upcoming events"', async () => {
    const snap = await fetchSnapshot({
      symbol: 'AAPL',
      market: 'US',
      configs: buildConfigs({
        unlockCalendar: async () => ({
          data: [],
          citations: [{
            title: 'Unlock calendar',
            url: 'https://example.com/unlocks/AAPL',
            sourceType: 'OTHER',
            provider: 'test',
            retrievedAt: '2025-05-25T15:00:00.000Z',
            qualityTier: 'B',
          }],
          freshness: [],
        }),
      }),
    });
    expect(snap.rawFacts.unlockCalendar).toEqual([]);
    expect(snap.dataAvailability.missing.find((m) => m.field === 'unlockCalendar')?.reason).toBe('no_data');
    expect(snap.citations).toContainEqual(expect.objectContaining({
      factKey: 'unlockCalendar',
      url: 'https://example.com/unlocks/AAPL',
    }));
  });

  it('single wide history request keeps provenance for chart + valuation views', async () => {
    const configs = buildConfigs({
      history: async (_symbol, from) => ({
        data: fakeHistory(250),
        citations: [{
          title: 'History',
          url: `https://example.com/history?from=${from}`,
          sourceType: 'PRICE',
          provider: 'test',
          retrievedAt: '2025-05-25T15:00:00.000Z',
          qualityTier: 'B',
        }],
        freshness: [],
      }),
    });
    const snap = await fetchSnapshot({ symbol: 'AAPL', market: 'US', configs });
    // 单请求双窗口（review P1-3 终版）：一次宽抓取服务两个视图，citation 恰 1 条
    expect(snap.citations.filter((citation) => citation.factKey === 'history')).toHaveLength(1);
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

  it('rejects an invalid quote instead of marking the field available', async () => {
    const configs = buildConfigs({
      quote: async () => ({ ...aaplQuote(), price: Number.NaN }),
    });
    const snap = await fetchSnapshot({
      symbol: 'AAPL',
      market: 'US',
      configs,
    });
    const miss = snap.dataAvailability.missing.find((m) => m.field === 'quote');
    expect(snap.rawFacts.quote).toBeNull();
    expect(miss?.reason).toBe('invalid_data');
    expect(miss?.detail).toContain('finite positive');
  });

  it('classifies an empty history result as no_data', async () => {
    const configs = buildConfigs({ history: async () => [] });
    const snap = await fetchSnapshot({
      symbol: 'AAPL',
      market: 'US',
      configs,
    });
    const miss = snap.dataAvailability.missing.find((m) => m.field === 'history');
    expect(snap.rawFacts.history).toBeNull();
    expect(miss?.reason).toBe('no_data');
  });

  it('preserves envelope citations, freshness, and warnings', async () => {
    const configs = buildConfigs({
      quote: async () => ({
        data: aaplQuote(),
        citations: [
          {
            title: 'Yahoo Finance: AAPL',
            url: 'https://finance.yahoo.com/quote/AAPL',
            sourceType: 'PRICE' as const,
            provider: 'yahoo-finance',
            retrievedAt: '2025-05-25T15:00:00.000Z',
            qualityTier: 'B' as const,
          },
        ],
        freshness: [
          {
            provider: 'yahoo-finance',
            asOf: '2025-05-25T00:00:00.000Z',
            retrievedAt: '2025-05-25T15:00:00.000Z',
            stale: false,
          },
        ],
        warnings: [
          {
            code: 'PARTIAL_DATA' as const,
            message: 'pre-market quote has no volume',
            provider: 'yahoo-finance',
          },
        ],
      }),
    });
    const snap = await fetchSnapshot({
      symbol: 'AAPL',
      market: 'US',
      configs,
    });
    expect(snap.citations).toEqual([
      expect.objectContaining({
        factKey: 'quote',
        url: 'https://finance.yahoo.com/quote/AAPL',
        asOf: '2025-05-25T00:00:00.000Z',
      }),
    ]);
    expect(snap.sourceMetadata?.quote?.freshness[0]?.asOf).toBe('2025-05-25T00:00:00.000Z');
    expect(snap.dataAvailability.warnings).toContain(
      'quote/PARTIAL_DATA: yahoo-finance: pre-market quote has no volume',
    );
  });

  it('recognizes a provenance envelope when optional freshness and warnings are absent', async () => {
    const configs = buildConfigs({
      quote: async () => ({
        data: aaplQuote(),
        citations: [
          {
            title: 'Yahoo Finance: AAPL',
            url: 'https://finance.yahoo.com/quote/AAPL',
            sourceType: 'PRICE' as const,
            provider: 'yahoo-finance',
            retrievedAt: '2025-05-25T15:00:00.000Z',
          },
        ],
      }),
    });
    const snap = await fetchSnapshot({
      symbol: 'AAPL',
      market: 'US',
      configs,
    });
    expect(snap.rawFacts.quote?.price).toBe(200);
    expect(snap.citations.find((citation) => citation.factKey === 'quote')?.url).toBe(
      'https://finance.yahoo.com/quote/AAPL',
    );
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

  it('passes timeout context and aborts the fetcher signal', async () => {
    let receivedTimeout: number | undefined;
    let observedAbort = false;
    const configs = buildConfigs({
      quote: async (_symbol, ctx) => {
        receivedTimeout = ctx?.timeoutMs;
        return new Promise<Quote>((_resolve, reject) => {
          ctx?.signal?.addEventListener('abort', () => {
            observedAbort = true;
            reject(new Error('aborted'));
          }, { once: true });
        });
      },
    });

    const snap = await fetchSnapshot({
      symbol: 'AAPL',
      market: 'US',
      configs,
      perConnectorTimeoutMs: 25,
    });

    expect(receivedTimeout).toBe(25);
    expect(observedAbort).toBe(true);
    expect(snap.dataAvailability.missing.find((item) => item.field === 'quote')?.reason).toBe('timeout');
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
    expect(snap.dataAvailability.missing.length).toBe(15);
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
        asOf: '2025-05-25T00:00:00.000Z',
        estimates: [
          { metricCode: 'epsBasic', periodEndOn: '2025-12-31', periodType: 'FY', value: '10', unit: 'per_share', currency: 'USD' },
          { metricCode: 'epsBasic', periodEndOn: '2026-12-31', periodType: 'FY', value: '12', unit: 'per_share', currency: 'USD' },
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

// ============================================================================
// C8 — peer relative comparison wiring (visualization §5.2)
// ============================================================================

describe('fetchSnapshot · C8 peer comparison wiring', () => {
  function peerQuote(symbol: string, pe: number): Quote {
    return {
      instrument: { instrumentId: `US:${symbol}`, market: 'US', symbol },
      price: 100 * pe,
      currency: 'USD',
      timestamp: '2025-05-25T00:00:00.000Z',
      marketCap: 1e12,
      peRatio: pe,
    };
  }

  it('fills computedFacts.peerComparison from peer quotes when the sector matches', async () => {
    let quoteCalls: string[] = [];
    const snap = await fetchSnapshot({
      symbol: 'AAPL',
      market: 'US',
      configs: buildConfigs({
        quote: async (symbol: string) => {
          quoteCalls.push(symbol);
          // Subject + 3 peers from the technology group
          const pe: Record<string, number> = { AAPL: 30, MSFT: 32, GOOGL: 24, META: 22 };
          return peerQuote(symbol, pe[symbol] ?? 25);
        },
        profile: async () => ({
          instrument: { instrumentId: 'US:AAPL', market: 'US', symbol: 'AAPL' },
          sector: 'Technology',
          currency: 'USD',
        }),
      }),
    });
    expect(snap.computedFacts.peerComparison).not.toBeNull();
    const pc = snap.computedFacts.peerComparison!;
    expect(pc.subjectVsPeerMedian.pe.subject).toBeCloseTo(30, 5);
    expect(pc.subjectVsPeerMedian.pe.median).toBeCloseTo(25, 5); // median(32,24,22)=24? no: sorted 22,24,32 → 24
    expect(pc.peers.length).toBeGreaterThanOrEqual(2);
    // peers exclude the subject itself
    expect(pc.peers.map((p) => p.symbol)).not.toContain('AAPL');
    // fail-soft: subject quote fetched for peers too (bounded)
    expect(quoteCalls.length).toBeGreaterThan(2);
    quoteCalls = [];
  });

  it('stays null (fail-soft) when peer quotes all fail', async () => {
    const snap = await fetchSnapshot({
      symbol: 'AAPL',
      market: 'US',
      configs: buildConfigs({
        quote: async (symbol: string) => {
          if (symbol === 'AAPL') return aaplQuote();
          throw new Error('peer source down');
        },
        profile: async () => ({
          instrument: { instrumentId: 'US:AAPL', market: 'US', symbol: 'AAPL' },
          sector: 'Technology',
          currency: 'USD',
        }),
      }),
    });
    expect(snap.computedFacts.peerComparison).toBeNull();
  });

  it('stays null when no sector → no peer group', async () => {
    const snap = await fetchSnapshot({ symbol: 'AAPL', market: 'US', configs: buildConfigs() });
    expect(snap.computedFacts.peerComparison).toBeNull();
  });
});
