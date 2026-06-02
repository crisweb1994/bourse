import { describe, expect, it, vi } from 'vitest';
import { CN } from '../../../markets/cn';
import {
  classifyReportType,
  makeFinancialStatementCN,
} from '../../../tools/cn/financial-statement';
import type { CnToolFetchLike } from '../../../tools/cn/_fetch-headers';

function fakeRes(opts: { ok?: boolean; status?: number; body: string }) {
  return {
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    text: () => Promise.resolve(opts.body),
  };
}

const ctx = { marketProfile: CN };

describe('tools/cn/financialStatement — classifyReportType', () => {
  it('classifies known REPORT_TYPE labels', () => {
    expect(classifyReportType('年报')).toBe('annual');
    expect(classifyReportType('一季报')).toBe('q1');
    expect(classifyReportType('中报')).toBe('semi');
    expect(classifyReportType('三季报')).toBe('q3');
  });
  it('falls back to other for unknown', () => {
    expect(classifyReportType('某未知')).toBe('other');
    expect(classifyReportType('')).toBe('other');
  });
});

describe('tools/cn/financialStatement — eastmoney primary path', () => {
  it('code 9201 / null result → graceful empty reports, not a throw', async () => {
    const body = JSON.stringify({
      result: null,
      success: false,
      message: '返回数据为空',
      code: 9201,
    });
    const fetchImpl: CnToolFetchLike = vi.fn(() =>
      Promise.resolve(fakeRes({ body })),
    );
    const tool = makeFinancialStatementCN({ fetchImpl });
    const result = await tool.run!({ symbol: '600519.SS', market: 'CN' }, ctx);
    expect(result.data.reports).toHaveLength(0);
  });

  it('parses quarterly rows into typed reports', async () => {
    const body = JSON.stringify({
      result: {
        data: [
          {
            SECUCODE: '600519.SH',
            SECURITY_NAME_ABBR: '贵州茅台',
            REPORT_DATE: '2025-09-30 00:00:00',
            REPORT_TYPE: '三季报',
            TOTAL_OPERATE_INCOME: 123456789012.34,
            PARENT_NETPROFIT: 54321098765.43,
            DEDUCT_PARENT_NETPROFIT: 53000000000,
            BASIC_EPS: 1.23,
            NETCASH_OPERATE: 110000000000,
          },
          {
            SECUCODE: '600519.SH',
            REPORT_DATE: '2025-06-30 00:00:00',
            REPORT_TYPE: '中报',
            TOTAL_OPERATE_INCOME: 80000000000,
            PARENT_NETPROFIT: 35000000000,
            DEDUCT_PARENT_NETPROFIT: 34000000000,
            BASIC_EPS: 0.78,
            NETCASH_OPERATE: 72000000000,
          },
        ],
      },
    });
    const fetchImpl: CnToolFetchLike = vi.fn(() =>
      Promise.resolve(fakeRes({ body })),
    );
    const tool = makeFinancialStatementCN({ fetchImpl });
    const result = await tool.run!(
      { symbol: '600519.SS', market: 'CN' },
      ctx,
    );
    expect(result.data.reports).toHaveLength(2);
    expect(result.data.reports[0]).toMatchObject({
      periodType: 'q3',
      revenue: 123456789012.34,
      netIncome: 54321098765.43,
      eps: 1.23,
    });
    expect(result.data.reports[1].periodType).toBe('semi');
    expect(result.trace?.source).toBe('eastmoney');
    expect(result.trace?.fallbacksTriggered).toBe(0);
  });

  it('skips rows with missing REPORT_DATE', async () => {
    const body = JSON.stringify({
      result: {
        data: [
          { REPORT_TYPE: '年报', TOTAL_OPERATE_INCOME: 1 }, // no date
          {
            REPORT_DATE: '2024-12-31 00:00:00',
            REPORT_TYPE: '年报',
            TOTAL_OPERATE_INCOME: 1000,
          },
        ],
      },
    });
    const fetchImpl: CnToolFetchLike = vi.fn(() =>
      Promise.resolve(fakeRes({ body })),
    );
    const tool = makeFinancialStatementCN({ fetchImpl });
    const result = await tool.run!(
      { symbol: '600519.SS', market: 'CN' },
      ctx,
    );
    expect(result.data.reports).toHaveLength(1);
    expect(result.data.reports[0].revenue).toBe(1000);
  });

  it('treats unparseable numeric fields as null', async () => {
    const body = JSON.stringify({
      result: {
        data: [
          {
            REPORT_DATE: '2024-12-31 00:00:00',
            REPORT_TYPE: '年报',
            TOTAL_OPERATE_INCOME: 'N/A',
            PARENT_NETPROFIT: null,
            DEDUCT_PARENT_NETPROFIT: 1000,
            BASIC_EPS: 0,
            NETCASH_OPERATE: undefined,
          },
        ],
      },
    });
    const fetchImpl: CnToolFetchLike = vi.fn(() =>
      Promise.resolve(fakeRes({ body })),
    );
    const tool = makeFinancialStatementCN({ fetchImpl });
    const result = await tool.run!(
      { symbol: '600519.SS', market: 'CN' },
      ctx,
    );
    expect(result.data.reports[0]).toMatchObject({
      revenue: null,
      netIncome: null,
      netIncomeExNRR: 1000,
      eps: 0,
      operatingCashFlow: null,
    });
  });

  it('respects limit (caps at 20)', async () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({
      REPORT_DATE: `2024-${String((i % 12) + 1).padStart(2, '0')}-01 00:00:00`,
      REPORT_TYPE: '年报',
      TOTAL_OPERATE_INCOME: i,
    }));
    const body = JSON.stringify({ result: { data: rows } });
    const fetchImpl: CnToolFetchLike = vi.fn(() =>
      Promise.resolve(fakeRes({ body })),
    );
    const tool = makeFinancialStatementCN({ fetchImpl });
    const result = await tool.run!(
      { symbol: '600519.SS', market: 'CN', limit: 5 },
      ctx,
    );
    expect(result.data.reports).toHaveLength(5);
  });

  it('throws retry-after on 429', async () => {
    const fetchImpl: CnToolFetchLike = vi.fn(() =>
      Promise.resolve(fakeRes({ ok: false, status: 429, body: '' })),
    );
    const tool = makeFinancialStatementCN({ fetchImpl });
    await expect(
      tool.run!({ symbol: '600519.SS', market: 'CN' }, ctx),
    ).rejects.toThrow(/retry-after/i);
  });
});

describe('tools/cn/financialStatement — cninfo fallback (not implemented sentinel)', () => {
  it('hits cninfo fallback that explicitly throws "not implemented"', async () => {
    let n = 0;
    const fetchImpl: CnToolFetchLike = vi.fn(() => {
      n++;
      if (n === 1) {
        // eastmoney fails first
        return Promise.resolve(fakeRes({ ok: false, status: 500, body: '' }));
      }
      // cninfo never gets a real HTTP call — it throws sync in the source map
      return Promise.resolve(fakeRes({ body: '' }));
    });
    const tool = makeFinancialStatementCN({ fetchImpl });
    await expect(
      tool.run!({ symbol: '600519.SS', market: 'CN' }, ctx),
    ).rejects.toThrow(/exhausted/);
    // cninfo branch throws before fetch, so only eastmoney made a request
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('tools/cn/financialStatement — URL shape', () => {
  it('builds eastmoney datacenter URL with correct security code', async () => {
    const seen: string[] = [];
    const fetchImpl: CnToolFetchLike = vi.fn((url) => {
      seen.push(url);
      return Promise.resolve(
        fakeRes({
          body: JSON.stringify({
            result: {
              data: [
                {
                  REPORT_DATE: '2024-12-31 00:00:00',
                  REPORT_TYPE: '年报',
                  TOTAL_OPERATE_INCOME: 1000,
                },
              ],
            },
          }),
        }),
      );
    });
    const tool = makeFinancialStatementCN({ fetchImpl });
    await tool.run!({ symbol: '300750.SZ', market: 'CN' }, ctx);
    expect(seen[0]).toContain('datacenter.eastmoney.com');
    expect(seen[0]).toContain('RPT_LICO_FN_CPD');
    expect(seen[0]).toContain('300750');
  });
});
