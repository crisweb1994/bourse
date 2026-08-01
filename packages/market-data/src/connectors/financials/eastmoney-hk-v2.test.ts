import { describe, expect, it } from 'vitest';
import type { FetchLike } from '../types';
import { FinancialsBundleV2Schema } from '../../ports/financials-v2';
import { createEastmoneyHkV2FinancialsConnector } from './eastmoney-hk-v2';

function row(overrides: Record<string, unknown>) {
  return {
    REPORT_DATE: '2025-03-31 00:00:00',
    DATE_TYPE_CODE: '001',
    NOTICE_DATE: '2025-06-30',
    OPERATE_INCOME: 100000,
    GROSS_PROFIT: 40000,
    HOLDER_PROFIT: 20000,
    BASIC_EPS: 1.2,
    DILUTED_EPS: 1.18,
    TOTAL_ASSETS: 500000,
    TOTAL_LIABILITIES: 200000,
    TOTAL_PARENT_EQUITY: 300000,
    NETCASH_OPERATE: 25000,
    ...overrides,
  };
}

/** 非 12 月财年发行人：FYE 2025-03-31，H1 2024-09-30，9M 2024-12-31。 */
function buildMarchYearEndFixture() {
  return {
    success: true,
    result: {
      data: [
        row({ REPORT_DATE: '2025-03-31 00:00:00', DATE_TYPE_CODE: '001', NOTICE_DATE: '2025-06-30' }),
        row({
          REPORT_DATE: '2024-12-31 00:00:00',
          DATE_TYPE_CODE: '004',
          NOTICE_DATE: '2025-02-20',
          OPERATE_INCOME: 75000,
          NETCASH_OPERATE: 18000,
        }),
        row({
          REPORT_DATE: '2024-09-30 00:00:00',
          DATE_TYPE_CODE: '002',
          NOTICE_DATE: '2024-11-20',
          OPERATE_INCOME: 50000,
          NETCASH_OPERATE: 12000,
        }),
        row({ REPORT_DATE: '2024-03-31 00:00:00', DATE_TYPE_CODE: '001', NOTICE_DATE: '2024-06-28' }),
        row({
          REPORT_DATE: '2023-09-30 00:00:00',
          DATE_TYPE_CODE: '002',
          NOTICE_DATE: '2023-11-20',
        }),
      ],
    },
  };
}

/** 自然年发行人：FYE 2024-12-31 + H1 2024-06-30。 */
function buildCalendarYearFixture() {
  return {
    success: true,
    result: {
      data: [
        row({ REPORT_DATE: '2024-12-31 00:00:00', DATE_TYPE_CODE: '001', NOTICE_DATE: '2025-03-25' }),
        row({
          REPORT_DATE: '2024-06-30 00:00:00',
          DATE_TYPE_CODE: '002',
          NOTICE_DATE: '2024-08-25',
          OPERATE_INCOME: 55000,
        }),
        row({ REPORT_DATE: '2023-12-31 00:00:00', DATE_TYPE_CODE: '001', NOTICE_DATE: '2024-03-25' }),
      ],
    },
  };
}

function makeFetch(opts: { mainRows?: unknown; incomeRows?: unknown; mainStatus?: number }) {
  const fetchLike: FetchLike = (async (url: string | URL) => {
    const u = typeof url === 'string' ? url : url.toString();
    if (u.includes('RPT_HKF10_FN_MAININDICATOR')) {
      const status = opts.mainStatus ?? 200;
      return {
        ok: status >= 200 && status < 300,
        status,
        async text() {
          return JSON.stringify(opts.mainRows ?? { success: true, result: { data: [] } });
        },
      } as Response;
    }
    if (u.includes('RPT_HKF10_FN_INCOME')) {
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify(
            opts.incomeRows ?? { success: true, result: { data: [{ CURRENCY_CODE: 'CNY' }] } },
          );
        },
      } as Response;
    }
    throw new Error(`unexpected fetch URL: ${u}`);
  }) as FetchLike;
  return fetchLike;
}

const NOW = new Date('2025-07-01T00:00:00.000Z');

function makeConnector(fetchLike: FetchLike) {
  return createEastmoneyHkV2FinancialsConnector({ fetchLike, now: () => NOW });
}

describe('eastmoney-hk-v2 — non-calendar fiscal year', () => {
  it('attributes H1/9M/FY to the fiscal-year-start year and marks YTD', async () => {
    const connector = makeConnector(makeFetch({ mainRows: buildMarchYearEndFixture() }));
    const result = await connector.fetchFinancials({ instrumentId: 'HK:00700', deriveTTM: false });
    expect(result.data).not.toBeNull();
    const bundle = result.data!;
    expect(bundle.schemaVersion).toBe('financials-v2');
    expect(bundle.provider).toBe('eastmoney-hk-financials-v2');
    expect(() => FinancialsBundleV2Schema.parse(bundle)).not.toThrow();

    const fy = bundle.periods.find((period) => period.id === 'period-2025-03-31-001')!;
    const h1 = bundle.periods.find((period) => period.id === 'period-2024-09-30-002')!;
    const nineM = bundle.periods.find((period) => period.id === 'period-2024-12-31-004')!;

    // FYE 2025-03-31 归属财年开始年 2024（FY2024/25）。
    expect(fy.fiscalYear).toBe(2024);
    expect(fy.fiscalPeriodType).toBe('FY');
    expect(h1.fiscalYear).toBe(2024);
    expect(h1.fiscalPeriodType).toBe('H1');
    expect(h1.periodStartOn).toBe('2024-04-01');
    expect(nineM.fiscalPeriodType).toBe('9M');
    expect(nineM.periodStartOn).toBe('2024-04-01');

    const h1Revenue = h1.facts.find((fact) => fact.metricCode === 'revenue')!;
    expect(h1Revenue.accumulation).toBe('YTD');
    expect(h1Revenue.periodStartOn).toBe('2024-04-01');
    const fyRevenue = fy.facts.find((fact) => fact.metricCode === 'revenue')!;
    expect(fyRevenue.accumulation).toBe('FY');

    const assets = fy.facts.find((fact) => fact.metricCode === 'totalAssets')!;
    expect(assets.periodKind).toBe('instant');
    expect(assets.accumulation).toBeUndefined();
  });

  it('does not use period end as publishedAt; uses NOTICE_DATE when present', async () => {
    const connector = makeConnector(makeFetch({ mainRows: buildMarchYearEndFixture() }));
    const result = await connector.fetchFinancials({ instrumentId: 'HK:00700', deriveTTM: false });
    const h1 = result.data!.periods.find((period) => period.id === 'period-2024-09-30-002')!;
    expect(h1.publishedAt).toBe('2024-11-20T00:00:00.000Z');
    expect(h1.periodEndOn).toBe('2024-09-30');
  });

  it('uses CNY reporting currency from the income report', async () => {
    const connector = makeConnector(makeFetch({ mainRows: buildMarchYearEndFixture() }));
    const result = await connector.fetchFinancials({ instrumentId: 'HK:00700', deriveTTM: false });
    const fy = result.data!.periods.find((period) => period.id === 'period-2025-03-31-001')!;
    const revenue = fy.facts.find((fact) => fact.metricCode === 'revenue')!;
    expect(revenue.currency).toBe('CNY');
    const eps = fy.facts.find((fact) => fact.metricCode === 'epsBasic')!;
    expect(eps.unit).toBe('per_share');
    expect(eps.currency).toBe('CNY');
  });

  it('keeps the later version when duplicate rows exist', async () => {
    const fixture = buildMarchYearEndFixture();
    fixture.result.data.push(
      row({
        REPORT_DATE: '2024-09-30 00:00:00',
        DATE_TYPE_CODE: '002',
        NOTICE_DATE: '2024-12-01',
        OPERATE_INCOME: 51000,
      }),
    );
    const connector = makeConnector(makeFetch({ mainRows: fixture }));
    const result = await connector.fetchFinancials({ instrumentId: 'HK:00700', deriveTTM: false });
    const h1 = result.data!.periods.find((period) => period.id === 'period-2024-09-30-002')!;
    expect(h1.publishedAt).toBe('2024-12-01T00:00:00.000Z');
    expect(h1.facts.find((fact) => fact.metricCode === 'revenue')!.value).toBe('51000');
  });
});

describe('eastmoney-hk-v2 — natural fiscal year and failures', () => {
  it('attributes calendar-year periods correctly', async () => {
    const connector = makeConnector(makeFetch({ mainRows: buildCalendarYearFixture() }));
    const result = await connector.fetchFinancials({ instrumentId: 'HK:00700', deriveTTM: false });
    const h1 = result.data!.periods.find((period) => period.id === 'period-2024-06-30-002')!;
    expect(h1.fiscalYear).toBe(2024);
    expect(h1.periodStartOn).toBe('2024-01-01');
  });

  it('fails with PARTIAL_DATA when reporting currency is unknown', async () => {
    const connector = makeConnector(
      makeFetch({ mainRows: buildCalendarYearFixture(), incomeRows: { success: true, result: { data: [] } } }),
    );
    const result = await connector.fetchFinancials({ instrumentId: 'HK:00700', deriveTTM: false });
    expect(result.data).toBeNull();
    expect(result.warnings[0].code).toBe('PARTIAL_DATA');
    expect(result.warnings[0].message).toContain('reporting_currency_unknown');
  });

  it('returns null data for no coverage without warnings', async () => {
    const connector = makeConnector(makeFetch({ mainRows: { success: true, result: { data: [] } } }));
    const result = await connector.fetchFinancials({ instrumentId: 'HK:00700', deriveTTM: false });
    expect(result.data).toBeNull();
    expect(result.warnings).toHaveLength(0);
  });

  it('rejects non-HK instruments', async () => {
    const connector = makeConnector(makeFetch({ mainRows: buildCalendarYearFixture() }));
    const result = await connector.fetchFinancials({ instrumentId: 'CN:600519', deriveTTM: false });
    expect(result.data).toBeNull();
    expect(result.warnings[0].code).toBe('UNSUPPORTED_MARKET');
  });
});
