import { beforeEach, describe, expect, it } from 'vitest';
import type { FetchLike } from '../types';
import {
  __resetYahooCrumbCache,
  __seedYahooCrumbCacheForTest,
  createYahooFinanceConnector,
} from './yahoo';

function stubFetch(body: unknown, ok = true, status = 200): FetchLike {
  return async () => ({ ok, status, json: async () => body });
}

/**
 * RFC financials §3.9: getQuote 现在并行调 chart + quoteSummary。
 * 测试用 routedStub 按 URL 分发，让 summaryDetail 也可被覆盖。
 */
function routedStubFetch(opts: {
  chart?: unknown;
  chartOk?: boolean;
  chartStatus?: number;
  summary?: unknown;
  summaryOk?: boolean;
  summaryStatus?: number;
  /** Spy hook — called when the test stub sees a summary URL. */
  onSummary?: () => void;
}): FetchLike {
  return async (url: string | URL) => {
    const u = typeof url === 'string' ? url : url.toString();
    if (u.includes('/quoteSummary/')) {
      opts.onSummary?.();
      return {
        ok: opts.summaryOk ?? true,
        status: opts.summaryStatus ?? 200,
        json: async () => opts.summary ?? {},
      } as Response;
    }
    return {
      ok: opts.chartOk ?? true,
      status: opts.chartStatus ?? 200,
      json: async () => opts.chart,
    } as Response;
  };
}

const nvdaMeta = {
  currency: 'USD',
  symbol: 'NVDA',
  exchangeName: 'NMS',
  regularMarketPrice: 123.45,
  previousClose: 120.0,
  regularMarketTime: 1747734600, // 2025-05-20T09:50:00Z
  regularMarketDayHigh: 124.5,
  regularMarketDayLow: 119.2,
  regularMarketVolume: 12_345_678,
  regularMarketDayOpen: 120.5,
  marketState: 'REGULAR',
};

function chartResponse(meta: typeof nvdaMeta | Record<string, unknown> | null) {
  return { chart: { result: meta ? [{ meta }] : [], error: null } };
}

describe('yahoo finance connector — getQuote', () => {
  // Seed the crumb cache before every test so fetchSummaryDetail bypasses
  // the live cookie+crumb dance (which would hit real Yahoo endpoints).
  // Tests that need to exercise the crumb refresh path can call
  // __resetYahooCrumbCache() inside themselves.
  beforeEach(() => {
    __resetYahooCrumbCache();
    __seedYahooCrumbCacheForTest('stub-crumb', 'A1=stub-cookie');
  });

  it('returns a fully populated Quote for US ticker', async () => {
    const fetchLike = stubFetch(chartResponse(nvdaMeta));
    const c = createYahooFinanceConnector();
    const out = await c.getQuote({ instrumentId: 'US:NVDA' }, { fetchLike });

    expect(out.schemaVersion).toBe('1.0');
    expect(out.data.instrument.instrumentId).toBe('US:NVDA');
    expect(out.data.instrument.providerSymbols?.yahoo).toBe('NVDA');
    expect(out.data.price).toBe(123.45);
    expect(out.data.currency).toBe('USD');
    expect(out.data.change).toBeCloseTo(3.45, 2);
    expect(out.data.changePct).toBeCloseTo(2.875, 2);
    expect(out.data.dayOpen).toBe(120.5);
    expect(out.data.dayHigh).toBe(124.5);
    expect(out.data.dayLow).toBe(119.2);
    expect(out.data.previousClose).toBe(120);
    expect(out.data.marketStatus).toBe('OPEN');
    expect(out.data.timestamp).toBe('2025-05-20T09:50:00.000Z');
    expect(out.freshness[0].provider).toBe('yahoo');
    expect(out.warnings).toHaveLength(0);
  });

  it('populates marketCap + peRatio from summaryDetail (RFC financials §3.9)', async () => {
    const fetchLike = routedStubFetch({
      chart: chartResponse(nvdaMeta),
      summary: {
        quoteSummary: {
          result: [
            {
              summaryDetail: {
                marketCap: { raw: 3_010_000_000_000, fmt: '3.01T' },
                trailingPE: { raw: 35.42 },
              },
            },
          ],
        },
      },
    });
    const c = createYahooFinanceConnector();
    const out = await c.getQuote({ instrumentId: 'US:NVDA' }, { fetchLike });
    expect(out.data.marketCap).toBe(3_010_000_000_000);
    expect(out.data.peRatio).toBe(35.42);
  });

  it('plan-v2 Wave 1.8 — disableSummaryDetail skips the v10 call entirely', async () => {
    let summaryCalled = false;
    const fetchLike = routedStubFetch({
      chart: chartResponse(nvdaMeta),
      summary: {
        quoteSummary: {
          result: [{ summaryDetail: { marketCap: { raw: 999, fmt: '999' } } }],
        },
      },
      onSummary: () => {
        summaryCalled = true;
      },
    });
    const c = createYahooFinanceConnector();
    const out = await c.getQuote(
      { instrumentId: 'US:NVDA' },
      { fetchLike, disableSummaryDetail: true },
    );
    expect(out.data.price).toBe(123.45);
    expect(out.data.marketCap).toBeUndefined();
    expect(out.data.peRatio).toBeUndefined();
    expect(summaryCalled).toBe(false);
  });

  it('quote still succeeds when summaryDetail fails (fail-soft)', async () => {
    const fetchLike = routedStubFetch({
      chart: chartResponse(nvdaMeta),
      summaryOk: false,
      summaryStatus: 401,
    });
    const c = createYahooFinanceConnector();
    const out = await c.getQuote({ instrumentId: 'US:NVDA' }, { fetchLike });
    expect(out.data.price).toBe(123.45); // 主路径未受影响
    expect(out.data.marketCap).toBeUndefined();
    expect(out.data.peRatio).toBeUndefined();
    expect(out.warnings).toHaveLength(0); // 不抛 warning
  });

  it('maps HK instrumentId to Yahoo suffix', async () => {
    let capturedUrl = '';
    const fetchLike: FetchLike = async (u: string) => {
      capturedUrl = u;
      return { ok: true, status: 200, json: async () => chartResponse({ ...nvdaMeta, currency: 'HKD', symbol: '0700.HK' }) };
    };
    const c = createYahooFinanceConnector();
    const out = await c.getQuote({ instrumentId: 'HK:00700' }, { fetchLike });
    expect(capturedUrl).toContain('/0700.HK?');
    expect(out.data.instrument.providerSymbols?.yahoo).toBe('0700.HK');
    expect(out.data.instrument.currency).toBe('HKD');
  });

  it('returns UNSUPPORTED_MARKET for JP/UK without calling fetch', async () => {
    let called = false;
    const fetchLike: FetchLike = async () => {
      called = true;
      return { ok: true, status: 200, json: async () => ({}) };
    };
    const c = createYahooFinanceConnector();
    const jp = await c.getQuote({ instrumentId: 'JP:7203' }, { fetchLike });
    expect(called).toBe(false);
    expect(jp.warnings[0].code).toBe('UNSUPPORTED_MARKET');
    expect(jp.data.price).toBeNaN();

    const uk = await c.getQuote({ instrumentId: 'UK:BARC' }, { fetchLike });
    expect(uk.warnings[0].code).toBe('UNSUPPORTED_MARKET');
  });

  it('returns INVALID_INSTRUMENT for malformed input', async () => {
    const c = createYahooFinanceConnector();
    const out = await c.getQuote({ instrumentId: 'NVDA' }, { fetchLike: stubFetch({}) });
    expect(out.warnings[0].code).toBe('INVALID_INSTRUMENT');
  });

  it('emits SOURCE_UNAVAILABLE on HTTP failure', async () => {
    const c = createYahooFinanceConnector();
    const out = await c.getQuote({ instrumentId: 'US:NVDA' }, { fetchLike: stubFetch({}, false, 503) });
    expect(out.warnings[0].code).toBe('SOURCE_UNAVAILABLE');
    expect(out.warnings[0].cause).toBe('HTTP 503');
  });

  it('handles chart.error payload', async () => {
    const fetchLike = stubFetch({ chart: { result: null, error: { code: 'Not Found', description: 'Symbol unknown' } } });
    const c = createYahooFinanceConnector();
    const out = await c.getQuote({ instrumentId: 'US:NVDA' }, { fetchLike });
    expect(out.warnings[0].code).toBe('SOURCE_UNAVAILABLE');
    expect(out.warnings[0].message).toContain('Symbol unknown');
  });

  it('handles empty result with PARTIAL_DATA', async () => {
    const fetchLike = stubFetch(chartResponse(null));
    const c = createYahooFinanceConnector();
    const out = await c.getQuote({ instrumentId: 'US:NVDA' }, { fetchLike });
    expect(out.warnings[0].code).toBe('PARTIAL_DATA');
  });

  it('omits change when previousClose is missing', async () => {
    const meta = { ...nvdaMeta, previousClose: undefined, chartPreviousClose: undefined };
    const fetchLike = stubFetch(chartResponse(meta));
    const c = createYahooFinanceConnector();
    const out = await c.getQuote({ instrumentId: 'US:NVDA' }, { fetchLike });
    expect(out.data.change).toBeUndefined();
    expect(out.data.changePct).toBeUndefined();
  });

  it('maps marketState variants', async () => {
    const c = createYahooFinanceConnector();
    for (const [state, expected] of [
      ['REGULAR', 'OPEN'],
      ['CLOSED', 'CLOSED'],
      ['POSTPOST', 'CLOSED'],
      ['PRE', 'PRE_MARKET'],
      ['POST', 'AFTER_HOURS'],
      ['WAT', 'UNKNOWN'],
    ] as const) {
      const fetchLike = stubFetch(chartResponse({ ...nvdaMeta, marketState: state }));
      const out = await c.getQuote({ instrumentId: 'US:NVDA' }, { fetchLike });
      expect(out.data.marketStatus).toBe(expected);
    }
  });
});

describe('yahoo finance connector — getProfile', () => {
  // Seed the crumb cache so fetchAssetProfile skips the live cookie+crumb dance.
  beforeEach(() => {
    __resetYahooCrumbCache();
    __seedYahooCrumbCacheForTest('stub-crumb', 'A1=stub-cookie');
  });

  function assetProfileResponse(ap: Record<string, unknown> | null) {
    return {
      quoteSummary: {
        result: ap ? [{ assetProfile: ap }] : [],
        error: null,
      },
    };
  }

  it('parses assetProfile fields (live shape) into CompanyProfile', async () => {
    const fetchLike = stubFetch(
      assetProfileResponse({
        longBusinessSummary: 'Apple Inc. designs, manufactures, and markets smartphones.',
        sector: 'Technology',
        industry: 'Consumer Electronics',
        fullTimeEmployees: 166000,
        website: 'https://www.apple.com',
        // extra fields the parser must ignore
        address1: 'One Apple Park Way',
        country: 'United States',
      }),
    );
    const c = createYahooFinanceConnector();
    const out = await c.getProfile!({ instrumentId: 'US:AAPL' }, { fetchLike });

    expect(out.warnings).toHaveLength(0);
    expect(out.data.instrument.instrumentId).toBe('US:AAPL');
    expect(out.data.instrument.providerSymbols?.yahoo).toBe('AAPL');
    expect(out.data.description).toContain('Apple Inc.');
    expect(out.data.sector).toBe('Technology');
    expect(out.data.industry).toBe('Consumer Electronics');
    expect(out.data.employees).toBe(166000);
    expect(out.data.website).toBe('https://www.apple.com');
    expect(out.freshness[0].provider).toBe('yahoo');
  });

  it('omits fields that are missing/blank in assetProfile', async () => {
    const fetchLike = stubFetch(
      assetProfileResponse({ sector: 'Technology', industry: '   ' }),
    );
    const c = createYahooFinanceConnector();
    const out = await c.getProfile!({ instrumentId: 'US:AAPL' }, { fetchLike });
    expect(out.data.sector).toBe('Technology');
    expect(out.data.industry).toBeUndefined();
    expect(out.data.description).toBeUndefined();
    expect(out.data.employees).toBeUndefined();
  });

  it('returns SOURCE_UNAVAILABLE when assetProfile module is absent', async () => {
    const fetchLike = stubFetch(assetProfileResponse(null));
    const c = createYahooFinanceConnector();
    const out = await c.getProfile!({ instrumentId: 'US:AAPL' }, { fetchLike });
    expect(out.warnings[0].code).toBe('SOURCE_UNAVAILABLE');
  });

  it('returns UNSUPPORTED_MARKET for non-US/HK without fetching', async () => {
    let called = false;
    const fetchLike: FetchLike = async () => {
      called = true;
      return { ok: true, status: 200, json: async () => ({}) };
    };
    const c = createYahooFinanceConnector();
    const out = await c.getProfile!({ instrumentId: 'JP:7203' }, { fetchLike });
    expect(called).toBe(false);
    expect(out.warnings[0].code).toBe('UNSUPPORTED_MARKET');
  });

  it('returns INVALID_INSTRUMENT for malformed input', async () => {
    const c = createYahooFinanceConnector();
    const out = await c.getProfile!({ instrumentId: 'AAPL' }, { fetchLike: stubFetch({}) });
    expect(out.warnings[0].code).toBe('INVALID_INSTRUMENT');
  });
});

describe('yahoo finance connector — getHistory', () => {
  function historyResponse(
    timestamps: number[],
    quote: { open?: (number | null)[]; high?: (number | null)[]; low?: (number | null)[]; close?: (number | null)[]; volume?: (number | null)[] },
    adjclose?: (number | null)[],
  ) {
    return {
      chart: {
        result: [
          {
            timestamp: timestamps,
            indicators: {
              quote: [quote],
              ...(adjclose ? { adjclose: [{ adjclose }] } : {}),
            },
          },
        ],
        error: null,
      },
    };
  }

  it('zips timestamps + OHLCV into PriceBar[]', async () => {
    const fetchLike = stubFetch(
      historyResponse(
        [1747600000, 1747686400, 1747772800],
        {
          open: [100, 102, 105],
          high: [104, 108, 110],
          low: [99, 100, 104],
          close: [103, 107, 109],
          volume: [1_000, 1_500, 1_700],
        },
        [102.5, 106.5, 108.5],
      ),
    );
    const out = await createYahooFinanceConnector().getHistory(
      { instrumentId: 'US:NVDA', from: '2026-05-01', to: '2026-05-20' },
      { fetchLike },
    );
    expect(out.data).toHaveLength(3);
    expect(out.data[0]).toMatchObject({
      open: 100,
      high: 104,
      low: 99,
      close: 103,
      volume: 1000,
      adjustedClose: 102.5,
    });
    expect(out.data[0].timestamp).toBe('2025-05-18T20:26:40.000Z');
    expect(out.warnings).toHaveLength(0);
  });

  it('skips entries where close is null (non-trading day inside range)', async () => {
    const fetchLike = stubFetch(
      historyResponse(
        [1747600000, 1747686400, 1747772800],
        { close: [100, null, 105], open: [99, null, 104], high: [101, null, 106], low: [98, null, 103] },
      ),
    );
    const out = await createYahooFinanceConnector().getHistory(
      { instrumentId: 'US:NVDA', from: '2026-05-01', to: '2026-05-20' },
      { fetchLike },
    );
    expect(out.data).toHaveLength(2);
  });

  it('appends PARTIAL_DATA warning for unsupported intervals but still returns 1d bars', async () => {
    const fetchLike = stubFetch(
      historyResponse([1747600000], { close: [100], open: [99], high: [101], low: [98] }),
    );
    const out = await createYahooFinanceConnector().getHistory(
      { instrumentId: 'US:NVDA', from: '2026-05-01', to: '2026-05-20', interval: '1h' },
      { fetchLike },
    );
    expect(out.data).toHaveLength(1);
    expect(out.warnings.some((w) => w.code === 'PARTIAL_DATA')).toBe(true);
  });

  it('rejects malformed time window', async () => {
    const out = await createYahooFinanceConnector().getHistory(
      { instrumentId: 'US:NVDA', from: '2026-05-20', to: '2026-05-01' },
      { fetchLike: stubFetch({}) },
    );
    expect(out.warnings[0].code).toBe('INVALID_INSTRUMENT');
  });

  it('rejects unsupported markets', async () => {
    const out = await createYahooFinanceConnector().getHistory(
      { instrumentId: 'JP:7203', from: '2026-05-01', to: '2026-05-20' },
      { fetchLike: stubFetch({}) },
    );
    expect(out.warnings[0].code).toBe('UNSUPPORTED_MARKET');
  });

  it('emits SOURCE_UNAVAILABLE on HTTP failure', async () => {
    const out = await createYahooFinanceConnector().getHistory(
      { instrumentId: 'US:NVDA', from: '2026-05-01', to: '2026-05-20' },
      { fetchLike: stubFetch({}, false, 500) },
    );
    expect(out.warnings[0].code).toBe('SOURCE_UNAVAILABLE');
  });
});
