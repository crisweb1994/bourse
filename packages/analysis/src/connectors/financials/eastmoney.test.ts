import { describe, expect, it } from 'vitest';
import type { FetchLike } from '../types';

/** Awaited return shape of FetchLike — mirrored locally because the type isn't exported. */
type FetchLikeResponse = Awaited<ReturnType<FetchLike>>;
import { createEastmoneyFinancialsConnector } from './eastmoney';

/**
 * RFC financials Phase 2 — Eastmoney datacenter-web connector unit tests.
 *
 * Strategy: mock fetch with hand-crafted responses for the 3 endpoints.
 * Period & line-item arithmetic is the core invariant (standalone Q
 * derivation from cumulative reports).
 */

const NOW = () => new Date('2026-05-25T00:00:00.000Z');

interface FixtureRow {
  REPORT_DATE: string; // YYYY-MM-DD
  DATE_TYPE_CODE: '001' | '002' | '003' | '004';
  NOTICE_DATE?: string;
  [k: string]: unknown;
}

/** Build a moutai-style minimal fixture covering FY2024 + 4 Q's of FY2025. */
function buildAaplLikeFixture() {
  // For each REPORT_DATE we need entries on all 3 endpoints with matching keys.
  // Numbers are simplified — what matters is the cumulative arithmetic.
  const dt = (
    reportDate: string,
    dateType: FixtureRow['DATE_TYPE_CODE'],
    extra: Record<string, number>,
  ): FixtureRow => ({
    SECURITY_CODE: '600519',
    REPORT_DATE: `${reportDate} 00:00:00`,
    DATE_TYPE_CODE: dateType,
    NOTICE_DATE: `${reportDate} 19:00:00`,
    ...extra,
  });

  const income: FixtureRow[] = [
    // FY2024 full year
    dt('2024-12-31', '001', { TOTAL_OPERATE_INCOME: 1000, OPERATE_COST: 200, OPERATE_PROFIT: 400, PARENT_NETPROFIT: 300 }),
    // FY2025 cumulative reports
    dt('2025-03-31', '003', { TOTAL_OPERATE_INCOME: 250, OPERATE_COST: 50, OPERATE_PROFIT: 100, PARENT_NETPROFIT: 75 }),
    dt('2025-06-30', '002', { TOTAL_OPERATE_INCOME: 520, OPERATE_COST: 105, OPERATE_PROFIT: 210, PARENT_NETPROFIT: 156 }),
    dt('2025-09-30', '004', { TOTAL_OPERATE_INCOME: 800, OPERATE_COST: 160, OPERATE_PROFIT: 320, PARENT_NETPROFIT: 240 }),
    dt('2025-12-31', '001', { TOTAL_OPERATE_INCOME: 1100, OPERATE_COST: 220, OPERATE_PROFIT: 440, PARENT_NETPROFIT: 330 }),
  ];
  const balance: FixtureRow[] = [
    // Balance sheet is point-in-time, only need one per period (no derivation).
    dt('2024-12-31', '001', { TOTAL_ASSETS: 5000, TOTAL_LIABILITIES: 1000, TOTAL_EQUITY: 4000, MONETARYFUNDS: 800 }),
    dt('2025-03-31', '003', { TOTAL_ASSETS: 5200, TOTAL_LIABILITIES: 1050, TOTAL_EQUITY: 4150, MONETARYFUNDS: 850 }),
    dt('2025-06-30', '002', { TOTAL_ASSETS: 5400, TOTAL_LIABILITIES: 1100, TOTAL_EQUITY: 4300, MONETARYFUNDS: 900 }),
    dt('2025-09-30', '004', { TOTAL_ASSETS: 5600, TOTAL_LIABILITIES: 1150, TOTAL_EQUITY: 4450, MONETARYFUNDS: 950 }),
    dt('2025-12-31', '001', { TOTAL_ASSETS: 5800, TOTAL_LIABILITIES: 1200, TOTAL_EQUITY: 4600, MONETARYFUNDS: 1000 }),
  ];
  const cashflow: FixtureRow[] = [
    dt('2024-12-31', '001', { NETCASH_OPERATE: 500, NETCASH_INVEST: -100, NETCASH_FINANCE: -200, CONSTRUCT_LONG_ASSET: 80 }),
    dt('2025-03-31', '003', { NETCASH_OPERATE: 100, NETCASH_INVEST: -20, NETCASH_FINANCE: -50, CONSTRUCT_LONG_ASSET: 15 }),
    dt('2025-06-30', '002', { NETCASH_OPERATE: 220, NETCASH_INVEST: -45, NETCASH_FINANCE: -100, CONSTRUCT_LONG_ASSET: 35 }),
    dt('2025-09-30', '004', { NETCASH_OPERATE: 360, NETCASH_INVEST: -70, NETCASH_FINANCE: -150, CONSTRUCT_LONG_ASSET: 55 }),
    dt('2025-12-31', '001', { NETCASH_OPERATE: 550, NETCASH_INVEST: -110, NETCASH_FINANCE: -220, CONSTRUCT_LONG_ASSET: 88 }),
  ];
  return { income, balance, cashflow };
}

function makeRoutedFetch(fixture: ReturnType<typeof buildAaplLikeFixture>): FetchLike {
  return async (url: string): Promise<FetchLikeResponse> => {
    const u = String(url);
    let rows: FixtureRow[];
    if (u.includes('RPT_DMSK_FN_INCOME')) rows = fixture.income;
    else if (u.includes('RPT_DMSK_FN_BALANCE')) rows = fixture.balance;
    else if (u.includes('RPT_DMSK_FN_CASHFLOW')) rows = fixture.cashflow;
    else throw new Error(`unexpected url: ${u}`);
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({ version: 'test', result: { pages: 1, data: rows } }),
    } as FetchLikeResponse;
  };
}

describe('createEastmoneyFinancialsConnector — happy path', () => {
  it('emits FY + 4 standalone Q periods per fiscal year', async () => {
    const c = createEastmoneyFinancialsConnector({
      fetchLike: makeRoutedFetch(buildAaplLikeFixture()),
      now: NOW,
    });
    const r = await c.fetchFinancials({ instrumentId: 'CN:600519', years: 2 });
    expect(r.warnings).toEqual([]);
    expect(r.data).not.toBeNull();
    const b = r.data!;
    expect(b.currency).toBe('CNY');

    // Newest-first ordering.
    const labels = b.periods.map((p) => p.fiscalPeriod);
    // The first one may be the derived TTM; remove it for ordering check.
    const withoutTTM = b.periods.filter((p) => p.kind !== 'TTM').map((p) => p.fiscalPeriod);
    expect(withoutTTM[0]).toBe('FY2025');
    expect(withoutTTM).toContain('Q4-FY2025');
    expect(withoutTTM).toContain('Q3-FY2025');
    expect(withoutTTM).toContain('Q2-FY2025');
    expect(withoutTTM).toContain('Q1-FY2025');
    expect(withoutTTM).toContain('FY2024');
  });

  it('derives standalone Q values via cumulative subtraction', async () => {
    const c = createEastmoneyFinancialsConnector({
      fetchLike: makeRoutedFetch(buildAaplLikeFixture()),
      now: NOW,
    });
    const r = await c.fetchFinancials({ instrumentId: 'CN:600519', years: 1 });
    const b = r.data!;

    const q1 = b.periods.find((p) => p.fiscalPeriod === 'Q1-FY2025')!;
    const q2 = b.periods.find((p) => p.fiscalPeriod === 'Q2-FY2025')!;
    const q3 = b.periods.find((p) => p.fiscalPeriod === 'Q3-FY2025')!;
    const q4 = b.periods.find((p) => p.fiscalPeriod === 'Q4-FY2025')!;

    // Q1 = first quarter cumulative = standalone Q1 (250).
    expect(q1.income.revenue?.value).toBe(250);
    // Q2 = H1 (520) - Q1 (250) = 270.
    expect(q2.income.revenue?.value).toBe(270);
    // Q3 = 9M (800) - H1 (520) = 280.
    expect(q3.income.revenue?.value).toBe(280);
    // Q4 = FY (1100) - 9M (800) = 300.
    expect(q4.income.revenue?.value).toBe(300);

    // Q1+Q2+Q3+Q4 must equal FY revenue.
    const fy = b.periods.find((p) => p.fiscalPeriod === 'FY2025')!;
    expect(
      q1.income.revenue!.value +
        q2.income.revenue!.value +
        q3.income.revenue!.value +
        q4.income.revenue!.value,
    ).toBe(fy.income.revenue!.value);
  });

  it('derives freeCashFlow per period via OCF - CapEx', async () => {
    const c = createEastmoneyFinancialsConnector({
      fetchLike: makeRoutedFetch(buildAaplLikeFixture()),
      now: NOW,
    });
    const r = await c.fetchFinancials({ instrumentId: 'CN:600519', years: 1 });
    const q1 = r.data!.periods.find((p) => p.fiscalPeriod === 'Q1-FY2025')!;
    // Q1 standalone: OCF=100, CapEx=15 → FCF=85.
    expect(q1.cashFlow.operatingCashFlow?.value).toBe(100);
    expect(q1.cashFlow.capitalExpenditures?.value).toBe(15);
    expect(q1.cashFlow.freeCashFlow?.value).toBe(85);
  });

  it('balance sheet uses point-in-time values, not subtracted', async () => {
    const c = createEastmoneyFinancialsConnector({
      fetchLike: makeRoutedFetch(buildAaplLikeFixture()),
      now: NOW,
    });
    const r = await c.fetchFinancials({ instrumentId: 'CN:600519', years: 1 });
    // Q4-FY2025 (12-31) total assets = 5800, NOT (FY-9M) = 200.
    const q4 = r.data!.periods.find((p) => p.fiscalPeriod === 'Q4-FY2025')!;
    expect(q4.balance.totalAssets?.value).toBe(5800);
  });

  it('derives TTM from the standalone quarterlies', async () => {
    const c = createEastmoneyFinancialsConnector({
      fetchLike: makeRoutedFetch(buildAaplLikeFixture()),
      now: NOW,
    });
    const r = await c.fetchFinancials({ instrumentId: 'CN:600519', years: 2 });
    const ttm = r.data!.periods.find((p) => p.kind === 'TTM');
    expect(ttm).toBeDefined();
    // TTM anchored at Q4-FY2025 (latest FY just closed via pickAnchor rule 3)
    // sums Q1+Q2+Q3+Q4-FY2025 revenue = 250+270+280+300 = 1100 = FY.
    expect(ttm!.income.revenue?.value).toBe(1100);
  });
});

describe('createEastmoneyFinancialsConnector — plan-v2 §5.1 extra fields', () => {
  // Single FY fixture with the extra columns populated. Verifies that
  // buildIncome / buildBalance / buildCashFlow read the EXTRA field
  // mappings and surface them on FinancialsBundle (parity with US XBRL).
  function fixtureWithExtras() {
    const r = (date: string, type: '001' | '002' | '003' | '004', extra: Record<string, number>) => ({
      SECURITY_CODE: '600519',
      REPORT_DATE: `${date} 00:00:00`,
      DATE_TYPE_CODE: type,
      NOTICE_DATE: `${date} 19:00:00`,
      ...extra,
    });
    return {
      income: [
        r('2024-12-31', '001', {
          TOTAL_OPERATE_INCOME: 1000,
          OPERATE_COST: 200,
          OPERATE_PROFIT: 400,
          PARENT_NETPROFIT: 300,
          FINANCE_EXPENSE: 15,
          INCOME_TAX: 80,
          RESEARCH_EXPENSE: 50,
          SALE_EXPENSE: 30,
          MANAGE_EXPENSE: 70,
        }),
      ],
      balance: [
        r('2024-12-31', '001', {
          TOTAL_ASSETS: 5000,
          TOTAL_LIABILITIES: 1000,
          TOTAL_EQUITY: 4000,
          MONETARYFUNDS: 800,
          ACCOUNTS_RECE: 250,
          INVENTORY: 600,
          GOODWILL: 100,
          INTANGIBLE_ASSET: 80,
          TOTAL_CURRENT_ASSETS: 2500,
          TOTAL_CURRENT_LIAB: 800,
          SHORT_LOAN: 200,
          ACCOUNTS_PAYABLE: 300,
        }),
      ],
      cashflow: [
        r('2024-12-31', '001', {
          NETCASH_OPERATE: 500,
          NETCASH_INVEST: -100,
          NETCASH_FINANCE: -200,
          CONSTRUCT_LONG_ASSET: 80,
          FA_IR_DEPR: 90,
          IA_AMORTIZE: 20,
          LPE_AMORTIZE: 5,
          ASSIGN_DIVIDEND_PORFIT: 40,
        }),
      ],
    };
  }

  it('income carries financeExpense → interestExpense, sga = sale + manage', async () => {
    const c = createEastmoneyFinancialsConnector({
      fetchLike: makeRoutedFetch(fixtureWithExtras()),
      now: NOW,
    });
    const r = await c.fetchFinancials({ instrumentId: 'CN:600519', years: 1 });
    const fy = r.data!.periods.find((p) => p.fiscalPeriod === 'FY2024')!;
    expect(fy.income.interestExpense?.value).toBe(15);
    expect(fy.income.incomeTaxExpense?.value).toBe(80);
    expect(fy.income.researchAndDevelopment?.value).toBe(50);
    // SG&A = sellExpense (30) + manageExpense (70) = 100
    expect(fy.income.sellingGeneralAdministrative?.value).toBe(100);
  });

  it('balance surfaces goodwill / current assets / liabilities / inventory', async () => {
    const c = createEastmoneyFinancialsConnector({
      fetchLike: makeRoutedFetch(fixtureWithExtras()),
      now: NOW,
    });
    const r = await c.fetchFinancials({ instrumentId: 'CN:600519', years: 1 });
    const fy = r.data!.periods.find((p) => p.fiscalPeriod === 'FY2024')!;
    expect(fy.balance.accountsReceivable?.value).toBe(250);
    expect(fy.balance.inventory?.value).toBe(600);
    expect(fy.balance.goodwill?.value).toBe(100);
    expect(fy.balance.intangibleAssets?.value).toBe(80);
    expect(fy.balance.currentAssets?.value).toBe(2500);
    expect(fy.balance.currentLiabilities?.value).toBe(800);
    expect(fy.balance.shortTermDebt?.value).toBe(200);
    expect(fy.balance.accountsPayable?.value).toBe(300);
  });

  it('cashFlow D&A sums depreciation + IA amortization + LPE amortization', async () => {
    const c = createEastmoneyFinancialsConnector({
      fetchLike: makeRoutedFetch(fixtureWithExtras()),
      now: NOW,
    });
    const r = await c.fetchFinancials({ instrumentId: 'CN:600519', years: 1 });
    const fy = r.data!.periods.find((p) => p.fiscalPeriod === 'FY2024')!;
    // 90 + 20 + 5 = 115
    expect(fy.cashFlow.depreciationAndAmortization?.value).toBe(115);
    expect(fy.cashFlow.paymentsOfDividends?.value).toBe(40);
  });

  it('partial D&A: missing LPE amortization still aggregates the other two', async () => {
    const fix = fixtureWithExtras();
    delete (fix.cashflow[0] as Record<string, unknown>).LPE_AMORTIZE;
    const c = createEastmoneyFinancialsConnector({
      fetchLike: makeRoutedFetch(fix),
      now: NOW,
    });
    const r = await c.fetchFinancials({ instrumentId: 'CN:600519', years: 1 });
    const fy = r.data!.periods.find((p) => p.fiscalPeriod === 'FY2024')!;
    // 90 + 20 = 110
    expect(fy.cashFlow.depreciationAndAmortization?.value).toBe(110);
  });
});

describe('createEastmoneyFinancialsConnector — failure paths', () => {
  it('returns UNSUPPORTED_MARKET for non-CN instruments', async () => {
    const c = createEastmoneyFinancialsConnector({
      fetchLike: makeRoutedFetch(buildAaplLikeFixture()),
      now: NOW,
    });
    const r = await c.fetchFinancials({ instrumentId: 'US:AAPL' });
    expect(r.data).toBeNull();
    expect(r.warnings[0]?.code).toBe('UNSUPPORTED_MARKET');
  });

  it('returns INVALID_INSTRUMENT when all 3 endpoints return zero rows', async () => {
    const emptyFetch: FetchLike = async () =>
      ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ result: { pages: 0, data: [] } }),
      }) as FetchLikeResponse;
    const c = createEastmoneyFinancialsConnector({ fetchLike: emptyFetch, now: NOW });
    const r = await c.fetchFinancials({ instrumentId: 'CN:000000' });
    expect(r.data).toBeNull();
    expect(r.warnings[0]?.code).toBe('INVALID_INSTRUMENT');
  });

  it('returns SOURCE_UNAVAILABLE when an endpoint HTTP-fails', async () => {
    const halfBroken: FetchLike = async (url) => {
      if (String(url).includes('CASHFLOW')) {
        return { ok: false, status: 500 } as FetchLikeResponse;
      }
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({ result: { pages: 1, data: buildAaplLikeFixture().income } }),
      } as FetchLikeResponse;
    };
    const c = createEastmoneyFinancialsConnector({ fetchLike: halfBroken, now: NOW });
    const r = await c.fetchFinancials({ instrumentId: 'CN:600519' });
    expect(r.data).toBeNull();
    expect(r.warnings[0]?.code).toBe('SOURCE_UNAVAILABLE');
  });
});
