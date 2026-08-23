import { describe, expect, it, vi } from 'vitest';
import {
  ResearchMarketDataClient,
  createResearchMarketDataClient,
} from './client';
import { createBuiltInSources } from './sources/built-in';
import { SourceRegistry } from './sources/registry';
import { createYahooFinanceConnector } from './connectors/finance/yahoo';
import type {
  CompanyProfile,
  PriceBar,
  ProviderFinancePort as FinancePort,
  Quote,
} from './ports/finance';
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

type BuiltInProviderPorts = Parameters<typeof createBuiltInSources>[0];

function providers(overrides: Partial<BuiltInProviderPorts> = {}): BuiltInProviderPorts {
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

class TestResearchMarketDataClient extends ResearchMarketDataClient {
  constructor(providerPorts: BuiltInProviderPorts) {
    super(new SourceRegistry(createBuiltInSources(providerPorts)));
  }
}

describe('ResearchMarketDataClient', () => {
  it('returns batch quotes in exactly the input order', async () => {
    const client = createResearchMarketDataClient(createBuiltInSources(providers({
      yahoo: finance({
        getQuote: async ({ instrumentId }) => result(quote(instrumentId, instrumentId === 'US:MSFT' ? 420 : 200), 'yahoo'),
      }),
    })));

    const responses = await client.getQuotes([
      { instrumentId: 'US:MSFT' },
      { instrumentId: 'US:AAPL' },
    ]);

    expect(responses.map((response) => response.data?.instrument.instrumentId)).toEqual(['US:MSFT', 'US:AAPL']);
    expect(responses.map((response) => response.data?.price)).toEqual([420, 200]);
  });

  it('routes market-calendar requests with the default policy', async () => {
    const client = createResearchMarketDataClient(createBuiltInSources(providers()));

    const response = await client.getMarketSession('HK', '2026-02-17T02:00:00.000Z');

    expect(response.status).toBe('ok');
    expect(response.data?.state).toBe('HOLIDAY');
    if (response.status !== 'ok') throw new Error('expected market session');
    expect(response.trace.selectedSource).toBe('market-calendar-rules');
  });

  it('routes calendar-only markets outside the phase-one research set', async () => {
    const client = createResearchMarketDataClient(createBuiltInSources(providers()));

    const response = await client.getMarketSession('JP', '2026-02-11T03:00:00.000Z');

    expect(response.status).toBe('ok');
    expect(response.data?.state).toBe('HOLIDAY');
  });

  it('reports an explicit unsupported capability when no CN screener source is registered', async () => {
    const client = createResearchMarketDataClient(createBuiltInSources(providers()));

    const descriptor = await client.describeEquityScreener('CN');
    const snapshot = await client.screenEquities({
      market: 'CN',
      universe: 'ACTIVE_COMMON_STOCKS',
      conditions: [{ metric: 'PRICE', operator: 'GTE', value: 1 }],
      sort: { metric: 'MARKET_CAP', direction: 'DESC' },
    });

    expect(descriptor.status).toBe('failed');
    if (descriptor.status !== 'failed') throw new Error('expected unavailable descriptor');
    expect(descriptor.error?.code).toBe('UNSUPPORTED_CAPABILITY');
    expect(descriptor.trace.attempts).toEqual([]);
    expect(snapshot.status).toBe('failed');
    if (snapshot.status !== 'failed') throw new Error('expected unavailable snapshot');
    expect(snapshot.error?.code).toBe('UNSUPPORTED_CAPABILITY');
    expect(snapshot.trace.attempts).toEqual([]);
  });

  it('routes screener descriptor and snapshot through the declared bulk source', async () => {
    const sourceId = 'eastmoney-cn-screener';
    const client = createResearchMarketDataClient(createBuiltInSources(providers({
      cnEquityScreener: {
        describe: async () => ({
          status: 'ok',
          data: {
            market: 'CN',
            metrics: [{ metric: 'PRICE', operators: ['GTE', 'LTE', 'BETWEEN'] }],
            sortableMetrics: ['PRICE'],
            delay: 'delayed',
            universeLabel: 'A shares',
            universeRules: ['Active common stocks'],
          },
          sourceId,
          citations: [],
          freshness: [],
          warnings: [],
        }),
        screen: async () => ({
          status: 'ok',
          data: {
            universeCount: 1,
            matchedCount: 0,
            providerAsOf: '2026-08-22T00:00:00.000Z',
            complete: true,
            truncated: false,
            items: [],
          },
          sourceId,
          citations: [],
          freshness: [],
          warnings: [],
        }),
      },
    })));

    const descriptor = await client.describeEquityScreener(
      'CN',
      {},
      { acceptedDelays: ['delayed'] },
    );
    const snapshot = await client.screenEquities({
      market: 'CN',
      universe: 'ACTIVE_COMMON_STOCKS',
      conditions: [{ metric: 'PRICE', operator: 'GTE', value: 1 }],
      sort: { metric: 'PRICE', direction: 'DESC' },
    }, {}, { acceptedDelays: ['delayed'] });

    expect(descriptor.status).toBe('ok');
    if (descriptor.status !== 'ok') throw new Error('expected descriptor');
    expect(descriptor.data?.metrics[0]?.metric).toBe('PRICE');
    expect(descriptor.trace.selectedSource).toBe(sourceId);
    expect(snapshot.status).toBe('ok');
    if (snapshot.status !== 'ok') throw new Error('expected snapshot');
    expect(snapshot.data?.matchedCount).toBe(0);
    expect(snapshot.trace.selectedSource).toBe(sourceId);
  });

  it('does not invoke a no-store screener when persistence-safe sources are required', async () => {
    const sourceId = 'eastmoney-cn-screener';
    const describe = vi.fn(async () => ({
      status: 'failed' as const,
      data: null,
      sourceId,
      citations: [],
      freshness: [],
      warnings: [],
    }));
    const screen = vi.fn(async () => ({
      status: 'failed' as const,
      data: null,
      sourceId,
      citations: [],
      freshness: [],
      warnings: [],
    }));
    const client = createResearchMarketDataClient(createBuiltInSources(providers({
      cnEquityScreener: { describe, screen },
    })));

    const descriptorResponse = await client.describeEquityScreener(
      'CN',
      {},
      { acceptedRedistribution: ['public-cache-allowed'] },
    );
    const response = await client.screenEquities({
      market: 'CN',
      universe: 'ACTIVE_COMMON_STOCKS',
      conditions: [{ metric: 'PRICE', operator: 'GTE', value: 1 }],
      sort: { metric: 'PRICE', direction: 'DESC' },
    }, {}, { acceptedRedistribution: ['public-cache-allowed'] });

    expect(descriptorResponse.status).toBe('failed');
    if (descriptorResponse.status !== 'failed') throw new Error('expected rejected descriptor');
    expect(descriptorResponse.error?.code).toBe('PERMISSION_DENIED');
    expect(response.status).toBe('failed');
    if (response.status !== 'failed') throw new Error('expected rejected screener');
    expect(response.error?.code).toBe('PERMISSION_DENIED');
    expect(response.trace.attempts).toContainEqual(expect.objectContaining({
      sourceId,
      reasonCode: 'POLICY_DISABLED',
    }));
    expect(describe).not.toHaveBeenCalled();
    expect(screen).not.toHaveBeenCalled();
  });

  it('routes HK earnings consensus through the declared capability', async () => {
    const client = createResearchMarketDataClient(createBuiltInSources(providers({
      yahoo: finance({
        fetchEarningsConsensus: async () => result({
          asOf: '2026-07-28T00:00:00.000Z',
          estimates: [{
            metricCode: 'epsBasic',
            periodEndOn: '2026-12-31',
            periodType: 'FY',
            value: '25.5',
            unit: 'per_share',
            currency: 'HKD',
            analystCount: 20,
          }],
        }, 'yahoo'),
      }),
    })));

    const response = await client.getEarningsConsensus('HK:0700');

    expect(response.status).toBe('ok');
    expect(response.data?.estimates[0]?.value).toBe('25.5');
  });

  it('routes CN ownership and market events through canonical source plugins', async () => {
    const client = createResearchMarketDataClient(createBuiltInSources(providers({
      cnOwnership: {
        listOwnership: async ({ instrumentId }) => result([{
          id: 'connect-1',
          instrumentId,
          kind: 'STOCK_CONNECT' as const,
          asOf: '2026-07-28',
          shanghaiNetFlow: '1.2',
          shenzhenNetFlow: '0.4',
          flowUnit: 'CNY_100M' as const,
        }], 'cn-public-ownership'),
      },
      cnEvents: {
        listEvents: async ({ instrumentId }) => result([{
          id: 'unlock-1',
          instrumentId,
          type: 'UNLOCK' as const,
          occurredAt: '2026-08-01',
          title: 'Unlock',
          shares: '5000000',
          unlockType: '定增',
        }], 'cn-public-events'),
      },
    })));

    const ownership = await client.getOwnership({ instrumentId: 'CN:600519', dataSet: 'stock-connect' });
    const events = await client.getMarketEvents({ instrumentId: 'CN:600519', dataSet: 'unlock' });

    expect(ownership.status).toBe('ok');
    expect(ownership.data?.[0]?.kind).toBe('STOCK_CONNECT');
    expect(events.status).toBe('ok');
    expect(events.data?.[0]?.type).toBe('UNLOCK');
  });

  it('splits explicit macro series so each series is routed independently', async () => {
    const calls: string[][] = [];
    const client = createResearchMarketDataClient(createBuiltInSources(providers({
      macro: {
        fetchMacro: async (input) => {
          calls.push(input.seriesCodes ?? []);
          const seriesCode = input.seriesCodes?.[0] ?? 'US.CPI.YOY';
          return result({
            market: input.market,
            observations: [{
              market: input.market,
              seriesCode,
              category: seriesCode.includes('GDP') ? 'growth' as const : 'inflation' as const,
              name: seriesCode,
              value: '2.5',
              unit: 'percent',
              frequency: 'ANNUAL' as const,
              periodStart: '2025-01-01',
              periodEnd: '2025-12-31',
              provider: 'official-macro',
              providerSeriesId: seriesCode,
            }],
          }, 'official-macro');
        },
      },
    })));

    const response = await client.getMacro({
      market: 'US',
      seriesCodes: ['US.CPI.YOY', 'US.GDP.GROWTH.YOY'],
    });

    expect(calls).toEqual([['US.CPI.YOY'], ['US.GDP.GROWTH.YOY']]);
    expect(response.data?.observations.map((item) => item.seriesCode))
      .toEqual(['US.CPI.YOY', 'US.GDP.GROWTH.YOY']);
  });

  it('routes filing list and document requests through the same source policy', async () => {
    const summary = {
      id: 'accession-1',
      sourceDocumentId: 'accession-1:primary.htm',
      instrumentId: 'US:AAPL',
      formType: '10-Q',
      filingDate: '2026-07-01',
      filingUrl: 'https://www.sec.gov/example',
      provider: 'sec-edgar',
    };
    const client = createResearchMarketDataClient(createBuiltInSources(providers({
      usFilings: {
        searchFilings: async () => result([summary], 'sec-edgar'),
        getFiling: async () => result({ ...summary, text: 'quarterly report' }, 'sec-edgar'),
      },
    })));

    const listed = await client.listFilings({ instrumentId: 'US:AAPL', forms: ['10-Q'], limit: 1 });
    const document = await client.getFilingDocument({ ...summary });

    expect(listed.data).toEqual([summary]);
    expect(document.data?.text).toBe('quarterly report');
    if (document.status !== 'ok' && document.status !== 'partial') throw new Error('expected filing document');
    expect(document.trace.selectedSource).toBe('sec-edgar');
  });

  it('uses configured commercial sources before key-free quote providers', async () => {
    const yahooQuote = vi.fn(async () => result(quote('US:AAPL', 100), 'yahoo'));
    const twelveQuote = vi.fn(async () => result(quote('US:AAPL', 250), 'twelve-data'));
    const client = new TestResearchMarketDataClient(providers({
      twelveData: finance({ getQuote: twelveQuote }),
      yahoo: finance({ getQuote: yahooQuote }),
    }));

    const response = await client.getQuote('US:AAPL');

    expect(response.data?.price).toBe(250);
    expect(twelveQuote).toHaveBeenCalledOnce();
    expect(yahooQuote).not.toHaveBeenCalled();
  });

  it('falls through unavailable commercial sources to the existing free chain', async () => {
    const client = new TestResearchMarketDataClient(providers({
      twelveData: finance({ getQuote: async () => result(quote('US:AAPL', Number.NaN), 'twelve-data') }),
      alphaVantage: finance({ getQuote: async () => result(quote('US:AAPL', Number.NaN), 'alpha-vantage') }),
      eodhd: finance({ getQuote: async () => result(quote('US:AAPL', Number.NaN), 'eodhd') }),
      yahoo: finance({ getQuote: async () => result(quote('US:AAPL', 205), 'yahoo') }),
    }));

    const response = await client.getQuote('US:AAPL');

    expect(response.data?.price).toBe(205);
    expect(response.warnings.some((warning) => warning.code === 'FALLBACK_USED')).toBe(true);
  });

  it('uses a configured commercial company profile before Yahoo', async () => {
    const yahooProfile = vi.fn(async ({ instrumentId }: { instrumentId: string }) => result({
      instrument: { instrumentId, market: 'US' as const, symbol: 'AAPL' },
      industry: 'Yahoo industry',
    }, 'yahoo'));
    const client = new TestResearchMarketDataClient(providers({
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
    const client = new TestResearchMarketDataClient(providers({
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

    expect(quoteResult.data?.price).toBe(201);
    expect(historyResult.data).toHaveLength(30);
    expect(quoteResult.warnings.some((warning) => warning.code === 'FALLBACK_USED')).toBe(true);
  });

  it('falls back from Yahoo to Tencent for HK quote', async () => {
    const client = new TestResearchMarketDataClient(providers({
      yahoo: finance({ getQuote: async () => result(quote('HK:0700', Number.NaN), 'yahoo') }),
      tencentHk: finance({ getQuote: async () => result(quote('HK:0700', 550), 'tencent-finance') }),
    }));

    const response = await client.getQuote('HK:0700');
    expect(response.data?.price).toBe(550);
    expect(response.warnings.some((warning) => warning.code === 'FALLBACK_USED')).toBe(true);
  });

  it('resolves a source-specific HK symbol before invoking a connector', async () => {
    let providerSymbol: string | undefined;
    const client = new TestResearchMarketDataClient(providers({
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
    const client = new TestResearchMarketDataClient(providers({
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
    const client = new TestResearchMarketDataClient(providers({
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
    const client = new TestResearchMarketDataClient(providers({ secProfile: { getProfile: sec } }));

    const response = await client.getProfile('HK:0700');
    expect(response.data?.industry).toBe('Software');
    expect(sec).not.toHaveBeenCalled();
  });

  it('falls back from Yahoo to Eastmoney for an HK profile', async () => {
    const hkProfile = vi.fn(async () => result({
      instrument: { instrumentId: 'HK:0700', market: 'HK' as const, symbol: '0700' },
      industry: 'Software Services',
    }, 'eastmoney-hk-profile'));
    const client = new TestResearchMarketDataClient(providers({
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
    const client = new TestResearchMarketDataClient(providers({
      yahoo: finance({ getQuote: async () => { throw new Error(`HTTP ${status}`); } }),
      nasdaq: finance({ getQuote: async () => result(quote('US:AAPL', 202), 'nasdaq') }),
    }));

    const response = await client.getQuote('US:AAPL');
    expect(response.data?.price).toBe(202);
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
    const client = new TestResearchMarketDataClient(providers({
      instrumentSearch: [
        { search: first },
        { search: second },
        { search: third },
      ],
    }));

    const response = await client.searchInstruments(' AAPL ');

    expect(response.data?.[0]?.symbol).toBe('AAPL');
    if (response.status !== 'ok' && response.status !== 'partial') throw new Error('expected search results');
    expect(response.trace.mergedSources).toEqual(['tencent-search']);
    expect(first).toHaveBeenCalledWith('AAPL', expect.any(AbortSignal));
    expect(second).toHaveBeenCalledWith('AAPL', expect.any(AbortSignal));
    expect(third).toHaveBeenCalledWith('AAPL', expect.any(AbortSignal));
  });

  it('ranks primary listings above OTC ADRs in merged search results', async () => {
    const otcAdr = {
      symbol: 'MPNGY',
      name: '美团',
      market: 'US',
      exchange: 'OTC',
      currency: 'USD',
      yahooSymbol: 'MPNGY',
    };
    const hkPrimary = {
      symbol: '3690',
      name: '美团w',
      market: 'HK',
      exchange: 'HKEX',
      currency: 'HKD',
      yahooSymbol: '3690.HK',
    };
    const client = new TestResearchMarketDataClient(providers({
      instrumentSearch: [
        { search: async () => [otcAdr] },
        { search: async () => [hkPrimary] },
      ],
    }));

    const response = await client.searchInstruments('美团');
    expect(response.data?.map((item) => item.symbol)).toEqual(['3690', 'MPNGY']);
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
