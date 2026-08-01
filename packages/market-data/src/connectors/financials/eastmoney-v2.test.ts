import { describe, expect, it } from 'vitest';
import type { FetchLike } from '../types';
import { FinancialsBundleV2Schema } from '../../ports/financials-v2';
import { createEastmoneyV2FinancialsConnector } from './eastmoney-v2';

function incomeRow(
  reportDate: string,
  dateType: string,
  values: Record<string, number>,
  extra: Record<string, unknown> = {},
) {
  return {
    SECURITY_CODE: '600519',
    REPORT_DATE: `${reportDate} 00:00:00`,
    NOTICE_DATE: `2025-08-20`,
    DATE_TYPE_CODE: dateType,
    REPORT_TYPE_CODE: '001',
    TOTAL_OPERATE_INCOME: 100,
    OPERATE_COST: 60,
    OPERATE_PROFIT: 30,
    NETPROFIT: 10,
    PARENT_NETPROFIT: 9,
    BASIC_EPS: 0.9,
    DILUTED_EPS: 0.89,
    ...values,
    ...extra,
  };
}

function balanceRow(reportDate: string, dateType: string, values: Record<string, number> = {}) {
  return {
    SECURITY_CODE: '600519',
    REPORT_DATE: `${reportDate} 00:00:00`,
    NOTICE_DATE: '2025-08-20',
    DATE_TYPE_CODE: dateType,
    TOTAL_ASSETS: 500,
    TOTAL_LIABILITIES: 200,
    TOTAL_EQUITY: 300,
    MONETARYFUNDS: 50,
    ...values,
  };
}

function cashflowRow(reportDate: string, dateType: string, values: Record<string, number> = {}) {
  return {
    SECURITY_CODE: '600519',
    REPORT_DATE: `${reportDate} 00:00:00`,
    NOTICE_DATE: '2025-08-20',
    DATE_TYPE_CODE: dateType,
    NETCASH_OPERATE: 20,
    CONSTRUCT_LONG_ASSET: 5,
    ...values,
  };
}

function buildFixture() {
  return {
    income: [
      incomeRow('2025-03-31', '003', {
        TOTAL_OPERATE_INCOME: 100,
        OPERATE_COST: 60,
        OPERATE_PROFIT: 30,
        NETPROFIT: 10,
        PARENT_NETPROFIT: 9,
        BASIC_EPS: 0.9,
        DILUTED_EPS: 0.89,
      }),
      incomeRow('2025-06-30', '002', {
        TOTAL_OPERATE_INCOME: 250,
        OPERATE_COST: 150,
        OPERATE_PROFIT: 80,
        NETPROFIT: 25,
        PARENT_NETPROFIT: 23,
        BASIC_EPS: 2.3,
        DILUTED_EPS: 2.28,
      }),
      incomeRow('2025-09-30', '004', {
        TOTAL_OPERATE_INCOME: 400,
        OPERATE_COST: 240,
        OPERATE_PROFIT: 130,
        NETPROFIT: 40,
        PARENT_NETPROFIT: 38,
      }),
      incomeRow('2025-12-31', '001', {
        TOTAL_OPERATE_INCOME: 600,
        OPERATE_COST: 360,
        OPERATE_PROFIT: 200,
        NETPROFIT: 60,
        PARENT_NETPROFIT: 57,
      }),
      incomeRow('2024-12-31', '001', {
        TOTAL_OPERATE_INCOME: 500,
        OPERATE_COST: 300,
      }),
    ],
    balance: [
      balanceRow('2025-03-31', '003'),
      balanceRow('2025-06-30', '002', { TOTAL_ASSETS: 520 }),
      balanceRow('2025-09-30', '004', { TOTAL_ASSETS: 540 }),
      balanceRow('2025-12-31', '001', { TOTAL_ASSETS: 560 }),
      balanceRow('2024-12-31', '001', { TOTAL_ASSETS: 480 }),
    ],
    cashflow: [
      cashflowRow('2025-03-31', '003', { NETCASH_OPERATE: 20, CONSTRUCT_LONG_ASSET: 5 }),
      cashflowRow('2025-06-30', '002', { NETCASH_OPERATE: 45, CONSTRUCT_LONG_ASSET: 10 }),
      cashflowRow('2025-09-30', '004', { NETCASH_OPERATE: 70, CONSTRUCT_LONG_ASSET: 16 }),
      cashflowRow('2025-12-31', '001', { NETCASH_OPERATE: 100, CONSTRUCT_LONG_ASSET: 20 }),
      cashflowRow('2024-12-31', '001', { NETCASH_OPERATE: 90, CONSTRUCT_LONG_ASSET: 18 }),
    ],
  };
}

function makeFetch(fixture: ReturnType<typeof buildFixture>) {
  const fetchLike: FetchLike = (async (url: string | URL) => {
    const u = typeof url === 'string' ? url : url.toString();
    const reportName = /reportName=([^&]+)/.exec(u)?.[1];
    const data =
      reportName === 'RPT_DMSK_FN_INCOME'
        ? fixture.income
        : reportName === 'RPT_DMSK_FN_BALANCE'
          ? fixture.balance
          : reportName === 'RPT_DMSK_FN_CASHFLOW'
            ? fixture.cashflow
            : [];
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({ success: true, result: { data } });
      },
    } as Response;
  }) as FetchLike;
  return fetchLike;
}

const NOW = new Date('2025-10-01T00:00:00.000Z');

function makeConnector(fixture: ReturnType<typeof buildFixture>) {
  return createEastmoneyV2FinancialsConnector({
    fetchLike: makeFetch(fixture),
    now: () => NOW,
  });
}

describe('eastmoney-v2 — reported cumulative + derived quarters', () => {
  it('builds a valid bundle keeping reported YTD periods and derived discrete quarters', async () => {
    const connector = makeConnector(buildFixture());
    const result = await connector.fetchFinancials({ instrumentId: 'CN:600519', deriveTTM: false });
    expect(result.data).not.toBeNull();
    const bundle = result.data!;
    expect(bundle.provider).toBe('eastmoney-financials-v2');
    expect(bundle.qualityTier).toBe('B');
    expect(() => FinancialsBundleV2Schema.parse(bundle)).not.toThrow();

    const h1 = bundle.periods.find((period) => period.id === 'period-2025-H1')!;
    const q1 = bundle.periods.find((period) => period.id === 'period-2025-Q1')!;
    const fy = bundle.periods.find((period) => period.id === 'period-2025-FY')!;
    expect(h1.fiscalPeriodType).toBe('H1');
    expect(h1.facts.find((fact) => fact.metricCode === 'revenue')!.value).toBe('250');
    expect(h1.facts.find((fact) => fact.metricCode === 'revenue')!.accumulation).toBe('YTD');
    expect(fy.facts.find((fact) => fact.metricCode === 'revenue')!.accumulation).toBe('FY');
    expect(q1.facts.find((fact) => fact.metricCode === 'revenue')!.periodStartOn).toBe('2025-01-01');
  });

  it('derives Q2/Q3/Q4 as computed discrete facts with real input fact IDs', async () => {
    const connector = makeConnector(buildFixture());
    const result = await connector.fetchFinancials({ instrumentId: 'CN:600519', deriveTTM: false });
    const q2 = result.data!.periods.find((period) => period.id === 'period-2025-Q2')!;
    const q3 = result.data!.periods.find((period) => period.id === 'period-2025-Q3')!;
    const q4 = result.data!.periods.find((period) => period.id === 'period-2025-Q4')!;

    const q2Revenue = q2.facts.find((fact) => fact.metricCode === 'revenue')!;
    expect(q2Revenue.value).toBe('150');
    expect(q2Revenue.accumulation).toBe('discrete');
    expect(q2Revenue.periodStartOn).toBe('2025-04-01');
    expect(q2Revenue.derivation).toEqual({
      kind: 'computed',
      formula: 'cn-discrete-quarter-v1',
      inputFactIds: ['period-2025-H1:revenue', 'period-2025-Q1:revenue'],
    });
    expect(q3.facts.find((fact) => fact.metricCode === 'revenue')!.value).toBe('150');
    expect(q4.facts.find((fact) => fact.metricCode === 'revenue')!.value).toBe('200');

    const allIds = new Set(result.data!.periods.flatMap((period) => period.facts.map((fact) => fact.id)));
    for (const period of [q2, q3, q4]) {
      for (const fact of period.facts) {
        if (fact.derivation.kind !== 'computed') continue;
        for (const inputId of fact.derivation.inputFactIds) {
          expect(allIds.has(inputId)).toBe(true);
        }
      }
    }
  });

  it('maps PARENT_NETPROFIT to netIncomeAttrib and NETPROFIT to netIncome separately', async () => {
    const connector = makeConnector(buildFixture());
    const result = await connector.fetchFinancials({ instrumentId: 'CN:600519', deriveTTM: false });
    const h1 = result.data!.periods.find((period) => period.id === 'period-2025-H1')!;
    const attrib = h1.facts.find((fact) => fact.metricCode === 'netIncomeAttrib')!;
    const netIncome = h1.facts.find((fact) => fact.metricCode === 'netIncome')!;
    expect(attrib.value).toBe('23');
    expect(netIncome.value).toBe('25');
    expect(attrib.provenance.sourceField).toBe('PARENT_NETPROFIT');
    expect(netIncome.provenance.sourceField).toBe('NETPROFIT');
  });

  it('keeps EPS reported on cumulative periods and never derives quarterly EPS', async () => {
    const connector = makeConnector(buildFixture());
    const result = await connector.fetchFinancials({ instrumentId: 'CN:600519', deriveTTM: false });
    const h1 = result.data!.periods.find((period) => period.id === 'period-2025-H1')!;
    const basic = h1.facts.find((fact) => fact.metricCode === 'epsBasic')!;
    const diluted = h1.facts.find((fact) => fact.metricCode === 'epsDiluted')!;
    expect(basic.value).toBe('2.3');
    expect(diluted.value).toBe('2.28');
    expect(basic.unit).toBe('per_share');
    const q2 = result.data!.periods.find((period) => period.id === 'period-2025-Q2')!;
    expect(q2.facts.some((fact) => fact.metricCode === 'epsBasic' || fact.metricCode === 'epsDiluted')).toBe(
      false,
    );
  });

  it('derives grossProfit and freeCashFlow per period', async () => {
    const connector = makeConnector(buildFixture());
    const result = await connector.fetchFinancials({ instrumentId: 'CN:600519', deriveTTM: false });
    const h1 = result.data!.periods.find((period) => period.id === 'period-2025-H1')!;
    const gross = h1.facts.find((fact) => fact.metricCode === 'grossProfit')!;
    const fcf = h1.facts.find((fact) => fact.metricCode === 'freeCashFlow')!;
    expect(gross.value).toBe('100');
    expect(gross.derivation.kind).toBe('computed');
    expect(fcf.value).toBe('35');
    expect(fcf.derivation.formula).toBe('ocf-minus-capex-v1');
  });

  it('emits instant balance facts without accumulation in reported and derived periods', async () => {
    const connector = makeConnector(buildFixture());
    const result = await connector.fetchFinancials({ instrumentId: 'CN:600519', deriveTTM: false });
    for (const period of result.data!.periods) {
      const assets = period.facts.find((fact) => fact.metricCode === 'totalAssets');
      if (!assets) continue;
      expect(assets.periodKind).toBe('instant');
      expect(assets.accumulation).toBeUndefined();
    }
  });

  it('prefers the newer restatement version by UPDATE_DATE', async () => {
    const fixture = buildFixture();
    fixture.income.push(
      incomeRow(
        '2025-06-30',
        '002',
        { TOTAL_OPERATE_INCOME: 260, OPERATE_COST: 155, PARENT_NETPROFIT: 24 },
        { UPDATE_DATE: '2025-09-01', REPORT_TYPE_CODE: '002' },
      ),
    );
    const connector = makeConnector(fixture);
    const result = await connector.fetchFinancials({ instrumentId: 'CN:600519', deriveTTM: false });
    const h1 = result.data!.periods.find((period) => period.id === 'period-2025-H1')!;
    expect(h1.facts.find((fact) => fact.metricCode === 'revenue')!.value).toBe('260');
    expect(h1.revision.kind).toBe('restated');
    expect(h1.facts.find((fact) => fact.metricCode === 'revenue')!.provenance.sourceRevisionId).toContain('002');
    // Q2 派生输入也跟随新版本。
    const q2 = result.data!.periods.find((period) => period.id === 'period-2025-Q2')!;
    expect(q2.facts.find((fact) => fact.metricCode === 'revenue')!.value).toBe('160');
  });

  it('caps periods to the requested number of fiscal years', async () => {
    const connector = makeConnector(buildFixture());
    const result = await connector.fetchFinancials({
      instrumentId: 'CN:600519',
      deriveTTM: false,
      years: 1,
    });
    const ids = result.data!.periods.map((period) => period.id);
    expect(ids).toContain('period-2025-FY');
    expect(ids).not.toContain('period-2024-FY');
  });
});

describe('eastmoney-v2 — failure paths', () => {
  it('rejects non-CN instruments', async () => {
    const connector = makeConnector(buildFixture());
    const result = await connector.fetchFinancials({ instrumentId: 'US:AAPL', deriveTTM: false });
    expect(result.data).toBeNull();
    expect(result.warnings[0].code).toBe('UNSUPPORTED_MARKET');
  });

  it('returns INVALID_INSTRUMENT when all endpoints are empty', async () => {
    const connector = makeConnector({
      income: [],
      balance: [],
      cashflow: [],
    });
    const result = await connector.fetchFinancials({ instrumentId: 'CN:600519', deriveTTM: false });
    expect(result.data).toBeNull();
    expect(result.warnings[0].code).toBe('INVALID_INSTRUMENT');
  });
});
