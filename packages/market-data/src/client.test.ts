import { describe, expect, it, vi } from 'vitest';
import {
  MarketDataClient,
  createMarketData,
  type MarketDataProviders,
} from './client';
import { createYahooFinanceConnector } from './connectors/finance/yahoo';
import type { CompanyProfile, FinancePort, PriceBar, Quote } from './ports/finance';
import type { ResearchResult } from './contracts/result';

function result<T>(data: T, provider = 'test'): ResearchResult<T> {
  return {
    schemaVersion: '1.0',
    data,
    citations: [{
      title: provider,
      url: `https://example.com/${provider}`,
      sourceType: 'PRICE',
      provider,
      retrievedAt: '2026-07-28T00:00:00.000Z',
    }],
    freshness: [{
      provider,
      asOf: '2026-07-28T00:00:00.000Z',
      retrievedAt: '2026-07-28T00:00:00.000Z',
      stale: false,
    }],
    warnings: [],
  };
}

function quote(instrumentId: string, price: number): Quote {
  const market = instrumentId.startsWith('HK:') ? 'HK' : 'US';
  return {
    instrument: { instrumentId, market, symbol: instrumentId.split(':')[1]! },
    price,
    currency: market === 'HK' ? 'HKD' : 'USD',
    timestamp: '2026-07-28T00:00:00.000Z',
  };
}

function bars(count = 30): PriceBar[] {
  return Array.from({ length: count }, (_, index) => ({
    timestamp: new Date(Date.UTC(2026, 5, index + 1)).toISOString(),
    open: 100 + index,
    high: 102 + index,
    low: 99 + index,
    close: 101 + index,
  }));
}

function finance(overrides: Partial<FinancePort> = {}): FinancePort {
  return {
    getQuote: async ({ instrumentId }) => result(quote(instrumentId, 100)),
    getHistory: async () => result(bars()),
    getProfile: async ({ instrumentId }) => result({
      instrument: {
        instrumentId,
        market: instrumentId.startsWith('HK:') ? 'HK' : 'US',
        symbol: instrumentId.split(':')[1]!,
      },
      industry: 'Software',
    }),
    ...overrides,
  };
}

function providers(overrides: Partial<MarketDataProviders> = {}): MarketDataProviders {
  const defaultFinance = finance();
  return {
    yahoo: defaultFinance,
    nasdaq: defaultFinance,
    sinaUs: defaultFinance,
    tencentHk: defaultFinance,
    cnFinance: defaultFinance,
    secProfile: {
      getProfile: async ({ instrumentId }) => result({
        instrument: { instrumentId, market: 'US', symbol: instrumentId.split(':')[1]! },
        industry: 'SEC industry',
      }, 'sec-edgar-profile'),
    },
    usFinancials: { fetchFinancials: async () => result(null) },
    cnFinancials: { fetchFinancials: async () => result(null) },
    hkFinancials: { fetchFinancials: async () => result(null) },
    usFilings: { searchFilings: async () => result([]) },
    cnFilings: { searchFilings: async () => result([]) },
    hkFilings: { searchFilings: async () => result([]) },
    macro: { fetchMacro: async ({ market }) => result({ market, observations: [] }) },
    ...overrides,
  };
}

describe('MarketDataClient', () => {
  it('uses configured commercial sources before key-free quote providers', async () => {
    const yahooQuote = vi.fn(async () => result(quote('US:AAPL', 100), 'yahoo'));
    const twelveQuote = vi.fn(async () => result(quote('US:AAPL', 250), 'twelve-data'));
    const client = new MarketDataClient(providers({
      twelveData: finance({ getQuote: twelveQuote }),
      yahoo: finance({ getQuote: yahooQuote }),
    }));

    const response = await client.getQuote('US:AAPL');

    expect(response.data.price).toBe(250);
    expect(twelveQuote).toHaveBeenCalledOnce();
    expect(yahooQuote).not.toHaveBeenCalled();
  });

  it('falls through unavailable commercial sources to the existing free chain', async () => {
    const client = new MarketDataClient(providers({
      twelveData: finance({ getQuote: async () => result(quote('US:AAPL', Number.NaN), 'twelve-data') }),
      alphaVantage: finance({ getQuote: async () => result(quote('US:AAPL', Number.NaN), 'alpha-vantage') }),
      eodhd: finance({ getQuote: async () => result(quote('US:AAPL', Number.NaN), 'eodhd') }),
      yahoo: finance({ getQuote: async () => result(quote('US:AAPL', 205), 'yahoo') }),
    }));

    const response = await client.getQuote('US:AAPL');

    expect(response.data.price).toBe(205);
    expect(response.warnings.some((warning) => warning.code === 'FALLBACK_USED')).toBe(true);
  });

  it('uses a configured commercial company profile before Yahoo', async () => {
    const yahooProfile = vi.fn(async ({ instrumentId }: { instrumentId: string }) => result({
      instrument: { instrumentId, market: 'US' as const, symbol: 'AAPL' },
      industry: 'Yahoo industry',
    }, 'yahoo'));
    const client = new MarketDataClient(providers({
      twelveData: finance({
        getProfile: async ({ instrumentId }) => result({
          instrument: { instrumentId, market: 'US', symbol: 'AAPL' },
          industry: 'Twelve Data industry',
        }, 'twelve-data'),
      }),
      yahoo: finance({ getProfile: yahooProfile }),
    }));

    const response = await client.getProfile('US:AAPL');

    expect(response.data?.industry).toBe('Twelve Data industry');
    expect(yahooProfile).not.toHaveBeenCalled();
  });

  it('falls back from empty Yahoo data to Nasdaq for US quote and history', async () => {
    const client = new MarketDataClient(providers({
      yahoo: finance({
        getQuote: async () => result(quote('US:AAPL', Number.NaN), 'yahoo'),
        getHistory: async () => result([], 'yahoo'),
      }),
      nasdaq: finance({
        getQuote: async () => result(quote('US:AAPL', 201), 'nasdaq'),
        getHistory: async () => result(bars(), 'nasdaq'),
      }),
    }));

    const quoteResult = await client.getQuote('US:AAPL');
    const historyResult = await client.getHistory({
      instrumentId: 'US:AAPL',
      from: '2026-06-01',
      to: '2026-07-28',
      interval: '1d',
    });

    expect(quoteResult.data.price).toBe(201);
    expect(historyResult.data).toHaveLength(30);
    expect(quoteResult.warnings.some((warning) => warning.code === 'FALLBACK_USED')).toBe(true);
  });

  it('falls back from Yahoo to Tencent for HK quote', async () => {
    const client = new MarketDataClient(providers({
      yahoo: finance({ getQuote: async () => result(quote('HK:0700', Number.NaN), 'yahoo') }),
      tencentHk: finance({ getQuote: async () => result(quote('HK:0700', 550), 'tencent-finance') }),
    }));

    const response = await client.getQuote('HK:0700');
    expect(response.data.price).toBe(550);
    expect(response.warnings.some((warning) => warning.code === 'FALLBACK_USED')).toBe(true);
  });

  it('resolves a source-specific HK symbol before invoking a connector', async () => {
    let providerSymbol: string | undefined;
    const client = new MarketDataClient(providers({
      yahoo: finance({
        getQuote: async ({ instrumentId }, ctx) => {
          providerSymbol = ctx?.resolvedInstrument?.providerSymbol;
          return result(quote(instrumentId, 550), 'yahoo');
        },
      }),
    }));

    await client.getQuote('HK:0700');

    expect(providerSymbol).toBe('0700.HK');
  });

  it('falls back from Eastmoney to Tencent for CN history', async () => {
    const client = new MarketDataClient(providers({
      cnFinance: finance({ getHistory: async () => result([], 'eastmoney') }),
      tencentCn: finance({ getHistory: async () => result(bars(), 'tencent-cn-history') }),
    }));

    const response = await client.getHistory({
      instrumentId: 'CN:600519',
      from: '2026-06-01',
      to: '2026-07-28',
      interval: '1d',
    });

    expect(response.data).toHaveLength(30);
    expect(response.warnings.some((warning) => warning.code === 'FALLBACK_USED')).toBe(true);
  });

  it('uses SEC only when the US Yahoo profile has no descriptive data', async () => {
    const secProfile: CompanyProfile = {
      instrument: { instrumentId: 'US:AAPL', market: 'US', symbol: 'AAPL' },
      industry: 'Electronic Computers',
    };
    const client = new MarketDataClient(providers({
      yahoo: finance({
        getProfile: async () => result({
          instrument: { instrumentId: 'US:AAPL', market: 'US', symbol: 'AAPL' },
        }),
      }),
      secProfile: { getProfile: async () => result(secProfile, 'sec-edgar-profile') },
    }));

    const response = await client.getProfile('US:AAPL');
    expect(response.data?.industry).toBe('Electronic Computers');
    expect(response.warnings.some((warning) => warning.code === 'FALLBACK_USED')).toBe(true);
  });

  it('returns the Yahoo profile for HK and does not call SEC', async () => {
    const sec = vi.fn(async () => result({
      instrument: { instrumentId: 'US:AAPL', market: 'US' as const, symbol: 'AAPL' },
      industry: 'SEC industry',
    }));
    const client = new MarketDataClient(providers({ secProfile: { getProfile: sec } }));

    const response = await client.getProfile('HK:0700');
    expect(response.data?.industry).toBe('Software');
    expect(sec).not.toHaveBeenCalled();
  });

  it('falls back from Yahoo to Eastmoney for an HK profile', async () => {
    const hkProfile = vi.fn(async () => result({
      instrument: { instrumentId: 'HK:0700', market: 'HK' as const, symbol: '0700' },
      industry: 'Software Services',
    }, 'eastmoney-hk-profile'));
    const client = new MarketDataClient(providers({
      yahoo: finance({
        getProfile: async () => result({
          instrument: { instrumentId: 'HK:0700', market: 'HK', symbol: '0700' },
        }, 'yahoo'),
      }),
      hkProfile: { getProfile: hkProfile },
    }));

    const response = await client.getProfile('HK:0700');
    expect(response.data?.industry).toBe('Software Services');
    expect(response.warnings.some((warning) => warning.code === 'FALLBACK_USED')).toBe(true);
    expect(hkProfile).toHaveBeenCalledOnce();
  });

  it.each(['401', '403', '429', '500'])('continues fallback after provider error %s', async (status) => {
    const client = new MarketDataClient(providers({
      yahoo: finance({ getQuote: async () => { throw new Error(`HTTP ${status}`); } }),
      nasdaq: finance({ getQuote: async () => result(quote('US:AAPL', 202), 'nasdaq') }),
    }));

    const response = await client.getQuote('US:AAPL');
    expect(response.data.price).toBe(202);
    expect(response.warnings.length).toBeGreaterThan(0);
  });

  it('merges instrument search providers instead of stopping at the first hit', async () => {
    const first = vi.fn(async () => []);
    const second = vi.fn(async () => [{
      symbol: 'AAPL',
      name: 'Apple Inc.',
      market: 'US',
      exchange: 'NASDAQ',
      currency: 'USD',
      yahooSymbol: 'AAPL',
    }]);
    const third = vi.fn(async () => []);
    const client = new MarketDataClient(providers({
      instrumentSearch: [
        { search: first },
        { search: second },
        { search: third },
      ],
    }));

    const response = await client.searchInstruments(' AAPL ');

    expect(response[0]?.symbol).toBe('AAPL');
    expect(first).toHaveBeenCalledWith('AAPL', undefined);
    expect(second).toHaveBeenCalledWith('AAPL', undefined);
    expect(third).toHaveBeenCalledWith('AAPL', undefined);
  });

});

describe('connector cancellation', () => {
  it('aborts the underlying fetch when the connector timeout expires', async () => {
    let observedAbort = false;
    const yahoo = createYahooFinanceConnector();
    const fetchLike = (_url: string, init?: { signal?: AbortSignal }) =>
      new Promise<never>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          observedAbort = true;
          reject(new Error('aborted'));
        }, { once: true });
      });

    const response = await yahoo.getHistory({
      instrumentId: 'US:AAPL',
      from: '2026-06-01',
      to: '2026-07-28',
      interval: '1d',
    }, { fetchLike, timeoutMs: 10 });

    expect(observedAbort).toBe(true);
    expect(response.warnings[0]?.code).toBe('SOURCE_UNAVAILABLE');
  });
});
