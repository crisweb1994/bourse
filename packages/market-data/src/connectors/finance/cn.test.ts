import { describe, expect, it } from 'vitest';
import type { FetchLike } from '../types';
import { createCnFinanceConnector } from './cn';

function tencentLine(opts: {
  name?: string;
  code?: string;
  price?: number;
  mc?: number;
  pe?: string | number;
  pb?: number;
  dayOpen?: number;
  prevClose?: number;
  dayHigh?: number;
  dayLow?: number;
  changeAmt?: number;
  changePct?: number;
  volume?: number;
  turnoverWan?: number;
  turnoverRatePct?: number;
  amplitudePct?: number;
  week52High?: number;
  week52Low?: number;
  floatMc?: number;
  bidAskPct?: number;
  volumeRatio?: number;
  sharesTotal?: number;
  sharesFloat?: number;
}) {
  // plan-v2 Wave 1.4 — tencent payload requires ≥80 tilde-separated fields.
  const fields = new Array(88).fill('');
  fields[1] = opts.name ?? '贵州茅台';
  fields[2] = opts.code ?? '600519';
  fields[3] = String(opts.price ?? 1820.5);
  fields[4] = opts.prevClose !== undefined ? String(opts.prevClose) : '';
  fields[5] = opts.dayOpen !== undefined ? String(opts.dayOpen) : '';
  fields[31] = opts.changeAmt !== undefined ? String(opts.changeAmt) : '';
  fields[32] = opts.changePct !== undefined ? String(opts.changePct) : '';
  fields[33] = opts.dayHigh !== undefined ? String(opts.dayHigh) : '';
  fields[34] = opts.dayLow !== undefined ? String(opts.dayLow) : '';
  fields[36] = opts.volume !== undefined ? String(opts.volume) : '';
  fields[37] = opts.turnoverWan !== undefined ? String(opts.turnoverWan) : '';
  fields[38] = opts.turnoverRatePct !== undefined ? String(opts.turnoverRatePct) : '';
  fields[39] = opts.pe === undefined ? 'null' : String(opts.pe);
  fields[41] = opts.week52High !== undefined ? String(opts.week52High) : '';
  fields[42] = opts.week52Low !== undefined ? String(opts.week52Low) : '';
  fields[43] = opts.amplitudePct !== undefined ? String(opts.amplitudePct) : '';
  fields[44] = opts.floatMc !== undefined ? String(opts.floatMc) : '';
  fields[45] = String(opts.mc ?? 22000);
  fields[46] = opts.pb !== undefined ? String(opts.pb) : '';
  fields[49] = opts.bidAskPct !== undefined ? String(opts.bidAskPct) : '';
  fields[52] = opts.volumeRatio !== undefined ? String(opts.volumeRatio) : '';
  fields[57] = opts.sharesTotal !== undefined ? String(opts.sharesTotal) : '';
  fields[72] = opts.sharesFloat !== undefined ? String(opts.sharesFloat) : '';
  return `v_sh${opts.code ?? '600519'}="${fields.join('~')}";`;
}

function tencentFetch(line: string, ok = true, status = 200): FetchLike {
  return async () => ({
    ok,
    status,
    json: async () => ({}),
    text: async () => line,
  });
}

function eastmoneyFetch(payload: unknown, ok = true, status = 200): FetchLike {
  return async () => ({
    ok,
    status,
    json: async () => payload,
  });
}

function failingFetch(status: number): FetchLike {
  return async () => ({
    ok: false,
    status,
    json: async () => ({}),
    text: async () => '',
  });
}

describe('cn finance connector — getQuote', () => {
  it('parses tencent payload happy path', async () => {
    const c = createCnFinanceConnector();
    const out = await c.getQuote(
      { instrumentId: 'CN:600519' },
      { fetchLike: tencentFetch(tencentLine({ price: 1820.5, mc: 22000, pe: 28.5 })) },
    );
    expect(out.schemaVersion).toBe('1.0');
    expect(out.data.instrument.instrumentId).toBe('CN:600519');
    expect(out.data.instrument.exchange).toBe('SSE');
    expect(out.data.price).toBeCloseTo(1820.5);
    expect(out.data.currency).toBe('CNY');
    expect(out.data.marketCap).toBeCloseTo(22000);
    expect(out.data.peRatio).toBeCloseTo(28.5);
    expect(out.warnings).toHaveLength(0);
    expect(out.citations[0]?.provider).toBe('tencent');
    expect(out.citations[0]?.qualityTier).toBe('B');
  });

  it('plan-v2 Wave 1.4 — extracts extended tencent fields (28-field payload)', async () => {
    const c = createCnFinanceConnector();
    const out = await c.getQuote(
      { instrumentId: 'CN:600519' },
      {
        fetchLike: tencentFetch(
          tencentLine({
            price: 1820.5,
            mc: 22000,
            pe: 28.5,
            pb: 5.98,
            dayOpen: 1800,
            prevClose: 1795,
            dayHigh: 1830,
            dayLow: 1790,
            changeAmt: 25.5,
            changePct: 1.42, // raw % from tencent
            volume: 50_000,
            turnoverWan: 91_000, // 万元
            turnoverRatePct: 0.4,
            amplitudePct: 2.23,
            week52High: 2100,
            week52Low: 1500,
            floatMc: 21_500,
            bidAskPct: 12.5,
            volumeRatio: 0.85,
            sharesTotal: 12.56, // 亿股
            sharesFloat: 12.50,
          }),
        ),
      },
    );
    expect(out.data.pbRatio).toBeCloseTo(5.98);
    expect(out.data.dayOpen).toBeCloseTo(1800);
    expect(out.data.dayHigh).toBeCloseTo(1830);
    expect(out.data.dayLow).toBeCloseTo(1790);
    expect(out.data.previousClose).toBeCloseTo(1795);
    expect(out.data.change).toBeCloseTo(25.5);
    expect(out.data.changePct).toBeCloseTo(0.0142, 4); // 1.42% → 0.0142 decimal
    expect(out.data.volume).toBeCloseTo(50_000);
    expect(out.data.turnover).toBeCloseTo(910_000_000); // 91,000 万元 → 9.1 亿元
    expect(out.data.turnoverRate).toBeCloseTo(0.004); // 0.4% → 0.004
    expect(out.data.amplitude).toBeCloseTo(0.0223);
    expect(out.data.week52High).toBeCloseTo(2100);
    expect(out.data.week52Low).toBeCloseTo(1500);
    expect(out.data.floatMarketCap).toBeCloseTo(21_500);
    expect(out.data.bidAskRatio).toBeCloseTo(0.125);
    expect(out.data.volumeRatio).toBeCloseTo(0.85);
    expect(out.data.sharesTotal).toBeCloseTo(12.56);
    expect(out.data.sharesFloat).toBeCloseTo(12.50);
  });

  it('extended tencent fields gracefully missing → undefined, no crash', async () => {
    const c = createCnFinanceConnector();
    const out = await c.getQuote(
      { instrumentId: 'CN:600519' },
      {
        // Only price + mcap + pe filled; everything else empty strings
        fetchLike: tencentFetch(tencentLine({ price: 100, mc: 1000, pe: 20 })),
      },
    );
    expect(out.data.price).toBeCloseTo(100);
    expect(out.data.pbRatio).toBeUndefined();
    expect(out.data.dayHigh).toBeUndefined();
    expect(out.data.turnoverRate).toBeUndefined();
    expect(out.data.sharesTotal).toBeUndefined();
  });

  it('infers SZSE for codes starting with 000/002/300', async () => {
    const c = createCnFinanceConnector();
    const out = await c.getQuote(
      { instrumentId: 'CN:000001' },
      { fetchLike: tencentFetch(tencentLine({ name: '平安银行', code: '000001', price: 12.5, mc: 250 })) },
    );
    expect(out.data.instrument.exchange).toBe('SZSE');
  });

  it('falls back to eastmoney when tencent fails, accumulates warning', async () => {
    // Compose a per-source fetchLike that delegates by URL host.
    const fetchLike: FetchLike = async (url) => {
      if (url.includes('gtimg.cn')) {
        return { ok: false, status: 500, json: async () => ({}), text: async () => '' };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: { f43: 1820.5, f116: 2.2e12, f9: 28.5 } }),
        text: async () => '',
      };
    };
    const c = createCnFinanceConnector();
    const out = await c.getQuote({ instrumentId: 'CN:600519' }, { fetchLike });
    expect(out.data.price).toBeCloseTo(1820.5);
    expect(out.data.marketCap).toBeCloseTo(22000); // 2.2e12 元 / 1e8 = 22000 亿元
    expect(out.warnings[0]?.code).toBe('SOURCE_UNAVAILABLE');
    expect(out.warnings[0]?.provider).toBe('tencent');
    expect(out.citations[0]?.provider).toBe('eastmoney');
  });

  it('translates 429 into RATE_LIMITED with retryAfter hint', async () => {
    const c = createCnFinanceConnector({ sources: ['tencent'] });
    const out = await c.getQuote({ instrumentId: 'CN:600519' }, { fetchLike: failingFetch(429) });
    // Sources exhausted → final SOURCE_UNAVAILABLE wraps the inner RATE_LIMITED
    expect(out.warnings.some((w) => w.code === 'RATE_LIMITED')).toBe(true);
    expect(out.warnings.find((w) => w.code === 'RATE_LIMITED')?.retryAfterMs).toBeGreaterThan(0);
  });

  it('returns INVALID_INSTRUMENT for non-CN markets', async () => {
    const c = createCnFinanceConnector();
    const out = await c.getQuote({ instrumentId: 'US:NVDA' }, { fetchLike: tencentFetch('') });
    expect(out.warnings[0]?.code).toBe('UNSUPPORTED_MARKET');
  });

  it('returns INVALID_INSTRUMENT when code has no inferable exchange', async () => {
    const c = createCnFinanceConnector();
    const out = await c.getQuote({ instrumentId: 'CN:999999' }, { fetchLike: tencentFetch('') });
    expect(out.warnings[0]?.code).toBe('INVALID_INSTRUMENT');
  });

  it('emits SOURCE_UNAVAILABLE when all sources exhausted', async () => {
    const c = createCnFinanceConnector();
    const fetchLike: FetchLike = async () => ({
      ok: false,
      status: 503,
      json: async () => ({}),
      text: async () => '',
    });
    const out = await c.getQuote({ instrumentId: 'CN:600519' }, { fetchLike });
    expect(out.data.price).toBeNaN();
    expect(out.warnings.some((w) => w.code === 'SOURCE_UNAVAILABLE' && /exhausted/.test(w.message))).toBe(true);
  });

  it('parses null PE field from tencent as undefined', async () => {
    const c = createCnFinanceConnector({ sources: ['tencent'] });
    const out = await c.getQuote(
      { instrumentId: 'CN:600519' },
      { fetchLike: tencentFetch(tencentLine({ pe: 'null' })) },
    );
    expect(out.data.peRatio).toBeUndefined();
  });
});

describe('cn finance connector — getProfile (Eastmoney F10 RPT_F10_BASIC_ORGINFO)', () => {
  // Connector reads res.text() when present (else res.json()); F10 returns
  // application/json so we provide both for realism.
  const profileFetch = (payload: unknown, ok = true, status = 200): FetchLike =>
    async () => ({
      ok,
      status,
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    });

  // Live-confirmed RPT_F10_BASIC_ORGINFO row shape (600519, 2026-05-30).
  function orgInfoResponse(row: Record<string, unknown> | null) {
    return {
      code: 0,
      success: true,
      message: 'ok',
      result: row ? { data: [row] } : { data: [] },
    };
  }

  it('parses ORG_PROFILE / EM2016 / ORG_WEB / EMP_NUM into CompanyProfile', async () => {
    const c = createCnFinanceConnector();
    const out = await c.getProfile!(
      { instrumentId: 'CN:600519' },
      {
        fetchLike: profileFetch(
          orgInfoResponse({
            SECUCODE: '600519.SH',
            ORG_NAME: '贵州茅台酒股份有限公司',
            ORG_PROFILE: '贵州茅台酒股份有限公司成立于1999年。',
            EM2016: '食品饮料-饮料-白酒',
            ORG_WEB: 'www.moutaichina.com',
            EMP_NUM: 34992,
          }),
        ),
      },
    );
    expect(out.warnings).toHaveLength(0);
    expect(out.data.instrument.instrumentId).toBe('CN:600519');
    expect(out.data.instrument.exchange).toBe('SSE');
    expect(out.data.description).toContain('贵州茅台');
    // EM2016 "食品饮料-饮料-白酒" → sector=head, industry=leaf
    expect(out.data.sector).toBe('食品饮料');
    expect(out.data.industry).toBe('白酒');
    expect(out.data.website).toBe('www.moutaichina.com');
    expect(out.data.employees).toBe(34992);
    expect(out.data.marketCap).toBeUndefined(); // not in this report
    expect(out.citations[0]?.provider).toBe('eastmoney');
  });

  it('parses EMP_NUM as string (eastmoney sometimes stringifies)', async () => {
    const c = createCnFinanceConnector();
    const out = await c.getProfile!(
      { instrumentId: 'CN:600519' },
      {
        fetchLike: profileFetch(
          orgInfoResponse({ EM2016: '食品饮料-白酒', EMP_NUM: '34992' }),
        ),
      },
    );
    expect(out.data.employees).toBe(34992);
    expect(out.data.sector).toBe('食品饮料');
    expect(out.data.industry).toBe('白酒');
  });

  it('builds SECUCODE filter with the .SH/.SZ suffix from the exchange', async () => {
    let capturedUrl = '';
    const fetchLike: FetchLike = async (url) => {
      capturedUrl = url;
      return {
        ok: true,
        status: 200,
        json: async () => orgInfoResponse({ ORG_PROFILE: 'x' }),
        text: async () => JSON.stringify(orgInfoResponse({ ORG_PROFILE: 'x' })),
      };
    };
    const c = createCnFinanceConnector();
    await c.getProfile!({ instrumentId: 'CN:000001' }, { fetchLike });
    // SZ code → SECUCODE 000001.SZ (URL-encoded)
    expect(capturedUrl).toContain('000001.SZ');
    expect(capturedUrl).toContain('RPT_F10_BASIC_ORGINFO');
  });

  it('non-array result (code 9201 / empty) → profile with just instrument, no warning', async () => {
    const c = createCnFinanceConnector();
    const out = await c.getProfile!(
      { instrumentId: 'CN:600519' },
      { fetchLike: profileFetch({ code: 9201, success: true, result: null }) },
    );
    expect(out.warnings).toHaveLength(0);
    expect(out.data.instrument.instrumentId).toBe('CN:600519');
    expect(out.data.description).toBeUndefined();
    expect(out.data.sector).toBeUndefined();
  });

  it('code 9501 (report config not found) → SOURCE_UNAVAILABLE', async () => {
    const c = createCnFinanceConnector();
    const out = await c.getProfile!(
      { instrumentId: 'CN:600519' },
      { fetchLike: profileFetch({ code: 9501, message: '报表配置不存在', result: null }) },
    );
    expect(out.warnings[0]?.code).toBe('SOURCE_UNAVAILABLE');
    expect(out.warnings[0]?.message).toContain('report config not found');
  });

  it('returns UNSUPPORTED_MARKET for non-CN markets', async () => {
    const c = createCnFinanceConnector();
    const out = await c.getProfile!({ instrumentId: 'US:AAPL' }, { fetchLike: profileFetch({}) });
    expect(out.warnings[0]?.code).toBe('UNSUPPORTED_MARKET');
  });

  it('returns INVALID_INSTRUMENT when exchange cannot be inferred', async () => {
    const c = createCnFinanceConnector();
    const out = await c.getProfile!({ instrumentId: 'CN:999999' }, { fetchLike: profileFetch({}) });
    expect(out.warnings[0]?.code).toBe('INVALID_INSTRUMENT');
  });
});

describe('cn finance connector — getHistory (Eastmoney push2his kline)', () => {
  const stubFetch = (klinesPayload: { data: { klines: string[] } | null }) =>
    (async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({}),
        text: async () => JSON.stringify(klinesPayload),
      })) as unknown as NonNullable<
        Parameters<typeof createCnFinanceConnector>[0]
      >['fetchLike'];

  it('parses Eastmoney klines into PriceBar[]', async () => {
    const out = await createCnFinanceConnector({
      fetchLike: stubFetch({
        data: {
          klines: [
            '2026-05-06,1365.10,1375.00,1379.00,1360.05,47806,6550750940.00,1.37',
            '2026-05-07,1375.00,1371.05,1388.00,1370.01,40461,5573286315.00,1.31',
          ],
        },
      }),
    }).getHistory({ instrumentId: 'CN:600519', from: '2026-05-01', to: '2026-05-25' });
    expect(out.warnings).toEqual([]);
    expect(out.data).toHaveLength(2);
    expect(out.data[0]).toMatchObject({
      timestamp: '2026-05-06',
      open: 1365.1,
      close: 1375,
      high: 1379,
      low: 1360.05,
      volume: 47806,
    });
    expect(out.citations[0]?.url).toContain('quote.eastmoney.com');
  });

  it('returns PARTIAL_DATA when klines array is empty', async () => {
    const out = await createCnFinanceConnector({
      fetchLike: stubFetch({ data: { klines: [] } }),
    }).getHistory({ instrumentId: 'CN:600519', from: '2026-05-01', to: '2026-05-25' });
    expect(out.data).toEqual([]);
    expect(out.warnings[0]?.code).toBe('PARTIAL_DATA');
  });

  it('rejects non-CN instrumentId with INVALID_INSTRUMENT', async () => {
    const out = await createCnFinanceConnector().getHistory({
      instrumentId: 'US:AAPL',
      from: '2026-05-01',
      to: '2026-05-25',
    });
    expect(out.data).toEqual([]);
    expect(out.warnings[0]?.code).toBe('INVALID_INSTRUMENT');
  });
});
