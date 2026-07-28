import { describe, expect, it } from 'vitest';
import type { FetchLike } from '../types';

/** Awaited return shape of FetchLike — mirrored locally (type isn't exported). */
type FetchLikeResponse = Awaited<ReturnType<FetchLike>>;
import { createEastmoneyHkFinancialsConnector } from './eastmoney-hk';

/**
 * RFC financials Phase 3 — Eastmoney HK F10 connector unit tests.
 *
 * Field shapes mirror the live RPT_HKF10_FN_MAININDICATOR response (verified
 * 2026-05 against 00700.HK / Tencent). MAININDICATOR.CURRENCY is always "HKD"
 * (trading currency); the real reporting currency comes from
 * RPT_HKF10_FN_INCOME.CURRENCY_CODE ("CNY" for Tencent).
 */

const NOW = () => new Date('2026-05-25T00:00:00.000Z');

interface MainRow {
  REPORT_DATE: string;
  DATE_TYPE_CODE: '001' | '002' | '003' | '004';
  REPORT_TYPE: string;
  CURRENCY: string; // always HKD (decoy — must NOT be used)
  [k: string]: unknown;
}

function mainRow(
  reportDate: string,
  dateType: MainRow['DATE_TYPE_CODE'],
  extra: Record<string, number>,
): MainRow {
  return {
    SECUCODE: '00700.HK',
    SECURITY_CODE: '00700',
    REPORT_DATE: `${reportDate} 00:00:00`,
    STD_REPORT_DATE: `${reportDate} 00:00:00`,
    DATE_TYPE_CODE: dateType,
    REPORT_TYPE: dateType === '001' ? '年报' : '季报',
    CURRENCY: 'HKD',
    IS_CNY_CODE: 0,
    ...extra,
  };
}

/** Tencent-like fixture: FY2024 + FY2025 + Q1 2026. Values in RMB (base 元). */
function buildTencentLikeFixture(): MainRow[] {
  return [
    mainRow('2026-03-31', '003', {
      OPERATE_INCOME: 196458000000,
      GROSS_PROFIT: 111265000000,
      HOLDER_PROFIT: 58093000000,
      BASIC_EPS: 6.431,
      DILUTED_EPS: 6.302,
      TOTAL_ASSETS: 2051390000000,
      TOTAL_LIABILITIES: 839763000000,
      TOTAL_PARENT_EQUITY: 1127652000000,
      NETCASH_OPERATE: 101351000000,
      NETCASH_INVEST: -10560000000,
      NETCASH_FINANCE: -12117000000,
    }),
    mainRow('2025-12-31', '001', {
      OPERATE_INCOME: 751766000000,
      GROSS_PROFIT: 422593000000,
      HOLDER_PROFIT: 224842000000,
      BASIC_EPS: 24.749,
      DILUTED_EPS: 24.153,
      TOTAL_ASSETS: 2000000000000,
      TOTAL_LIABILITIES: 845848000000,
      TOTAL_PARENT_EQUITY: 1154152000000,
      NETCASH_OPERATE: 250000000000,
      NETCASH_INVEST: -50000000000,
      NETCASH_FINANCE: -60000000000,
    }),
    mainRow('2024-12-31', '001', {
      OPERATE_INCOME: 660257000000,
      GROSS_PROFIT: 349200000000,
      HOLDER_PROFIT: 194073000000,
      BASIC_EPS: 20.9,
      DILUTED_EPS: 20.4,
      TOTAL_ASSETS: 1800000000000,
      TOTAL_LIABILITIES: 826452000000,
      TOTAL_PARENT_EQUITY: 973548000000,
      NETCASH_OPERATE: 220000000000,
      NETCASH_INVEST: -40000000000,
      NETCASH_FINANCE: -55000000000,
    }),
  ];
}

const INCOME_CNY_ROWS = [
  { CURRENCY: '人民币', CURRENCY_CODE: 'CNY', STD_ITEM_CODE: '004011202' },
  { CURRENCY: '人民币', CURRENCY_CODE: 'CNY', STD_ITEM_CODE: '004040002' },
];

function makeFetch(opts: {
  main?: unknown;
  income?: unknown;
  mainStatus?: number;
}): FetchLike {
  return async (url: string): Promise<FetchLikeResponse> => {
    const u = String(url);
    if (u.includes('RPT_HKF10_FN_MAININDICATOR')) {
      return {
        ok: (opts.mainStatus ?? 200) < 400,
        status: opts.mainStatus ?? 200,
        text: async () => JSON.stringify(opts.main),
      } as FetchLikeResponse;
    }
    if (u.includes('RPT_HKF10_FN_INCOME')) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(opts.income),
      } as FetchLikeResponse;
    }
    throw new Error(`unexpected url: ${u}`);
  };
}

describe('createEastmoneyHkFinancialsConnector — happy path', () => {
  it('maps MAININDICATOR → bundle and resolves currency from INCOME.CURRENCY_CODE', async () => {
    const c = createEastmoneyHkFinancialsConnector({
      fetchLike: makeFetch({
        main: { result: { data: buildTencentLikeFixture() } },
        income: { result: { data: INCOME_CNY_ROWS } },
      }),
      now: NOW,
    });

    const res = await c.fetchFinancials({ instrumentId: 'HK:0700' });
    const bundle = res.data;
    expect(bundle).not.toBeNull();
    if (!bundle) throw new Error('expected bundle');

    // Reporting currency from INCOME, NOT MAININDICATOR.CURRENCY ('HKD').
    expect(bundle.currency).toBe('CNY');
    expect(bundle.provider).toBe('eastmoney-hk-financials');
    expect(bundle.qualityTier).toBe('B');
    expect(res.warnings).toHaveLength(0);

    // Latest-first ordering; first row = Q1 2026 (interim → kind 'Q').
    const q1 = bundle.periods[0];
    expect(q1.kind).toBe('Q');
    expect(q1.fiscalYearEnd).toBe('2026-03-31');
    expect(q1.income.revenue).toEqual({ value: 196458000000, unit: 'CNY' });
    expect(q1.income.grossProfit).toEqual({ value: 111265000000, unit: 'CNY' });
    expect(q1.income.netIncome).toEqual({ value: 58093000000, unit: 'CNY' });
    // Diluted EPS preferred over basic.
    expect(q1.income.eps).toEqual({ value: 6.302, unit: 'CNY/shares' });
    expect(q1.balance.totalAssets).toEqual({ value: 2051390000000, unit: 'CNY' });
    expect(q1.balance.totalLiabilities).toEqual({ value: 839763000000, unit: 'CNY' });
    expect(q1.balance.totalStockholdersEquity).toEqual({ value: 1127652000000, unit: 'CNY' });
    expect(q1.cashFlow.operatingCashFlow).toEqual({ value: 101351000000, unit: 'CNY' });
    expect(q1.cashFlow.investingCashFlow).toEqual({ value: -10560000000, unit: 'CNY' });
    expect(q1.cashFlow.financingCashFlow).toEqual({ value: -12117000000, unit: 'CNY' });

    // FY2025 row present and tagged FY.
    const fy2025 = bundle.periods.find((p) => p.fiscalPeriod === 'FY2025');
    expect(fy2025?.kind).toBe('FY');
    expect(fy2025?.income.revenue?.value).toBe(751766000000);
    expect(fy2025?.income.netIncome?.value).toBe(224842000000);
    expect(fy2025?.balance.totalStockholdersEquity?.value).toBe(1154152000000);
  });

  it('falls back to BASIC_EPS when DILUTED_EPS missing', async () => {
    const rows = buildTencentLikeFixture();
    delete rows[0].DILUTED_EPS;
    const c = createEastmoneyHkFinancialsConnector({
      fetchLike: makeFetch({
        main: { result: { data: rows } },
        income: { result: { data: INCOME_CNY_ROWS } },
      }),
      now: NOW,
    });
    const res = await c.fetchFinancials({ instrumentId: 'HK:0700' });
    expect(res.data?.periods[0].income.eps).toEqual({ value: 6.431, unit: 'CNY/shares' });
  });

  it('defaults currency to HKD + warns when INCOME currency unavailable', async () => {
    const c = createEastmoneyHkFinancialsConnector({
      fetchLike: makeFetch({
        main: { result: { data: buildTencentLikeFixture() } },
        income: { result: { data: [] } }, // no CURRENCY_CODE rows
      }),
      now: NOW,
    });
    const res = await c.fetchFinancials({ instrumentId: 'HK:0700' });
    expect(res.data?.currency).toBe('HKD');
    expect(res.warnings.some((w) => /currency/i.test(w.message))).toBe(true);
  });
});

describe('createEastmoneyHkFinancialsConnector — empty / rot handling', () => {
  it('code 9201 (no data) → null bundle, NOT a throw', async () => {
    const c = createEastmoneyHkFinancialsConnector({
      fetchLike: makeFetch({
        main: { success: false, result: null, message: '返回数据为空', code: 9201 },
        income: { success: false, result: null, code: 9201 },
      }),
      now: NOW,
    });
    const res = await c.fetchFinancials({ instrumentId: 'HK:99999' });
    expect(res.data).toBeNull();
    // No-data is not an error — no warnings emitted.
    expect(res.warnings).toHaveLength(0);
  });

  it('non-array result → null bundle', async () => {
    const c = createEastmoneyHkFinancialsConnector({
      fetchLike: makeFetch({
        main: { result: { data: null } },
        income: { result: { data: null } },
      }),
      now: NOW,
    });
    const res = await c.fetchFinancials({ instrumentId: 'HK:0700' });
    expect(res.data).toBeNull();
  });

  it('code 9501 (report config not found) → SOURCE_UNAVAILABLE failure', async () => {
    const c = createEastmoneyHkFinancialsConnector({
      fetchLike: makeFetch({
        main: { success: false, result: null, message: '报表配置不存在', code: 9501 },
        income: { result: { data: INCOME_CNY_ROWS } },
      }),
      now: NOW,
    });
    const res = await c.fetchFinancials({ instrumentId: 'HK:0700' });
    expect(res.data).toBeNull();
    expect(res.warnings[0]?.code).toBe('SOURCE_UNAVAILABLE');
    expect(res.warnings[0]?.message).toMatch(/report config not found/i);
  });

  it('non-HK instrument → UNSUPPORTED_MARKET', async () => {
    const c = createEastmoneyHkFinancialsConnector({
      fetchLike: makeFetch({ main: { result: { data: [] } } }),
      now: NOW,
    });
    const res = await c.fetchFinancials({ instrumentId: 'US:AAPL' });
    expect(res.data).toBeNull();
    expect(res.warnings[0]?.code).toBe('UNSUPPORTED_MARKET');
  });
});
