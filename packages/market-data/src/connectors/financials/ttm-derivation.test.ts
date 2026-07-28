import { describe, expect, it } from 'vitest';
import type { FinancialsPeriodEntry } from '../../ports/financials';
import { deriveTTM } from './ttm-derivation';

// ============================================================================
// Fixture helpers
// ============================================================================

function lineItem(value: number, unit = 'USD') {
  return { value, unit };
}

function quarterEntry(
  fy: number,
  fp: 'Q1' | 'Q2' | 'Q3' | 'Q4',
  vals: { revenue: number; netIncome: number; ocf: number; capex: number },
): FinancialsPeriodEntry {
  return {
    fiscalPeriod: `${fp}-FY${fy}`,
    kind: 'Q',
    fiscalYearEnd: '2024-09-28',
    filed: '2024-11-01',
    formType: '10-Q',
    income: {
      revenue: lineItem(vals.revenue),
      netIncome: lineItem(vals.netIncome),
    },
    balance: {
      totalAssets: lineItem(364_980_000_000),
    },
    cashFlow: {
      operatingCashFlow: lineItem(vals.ocf),
      capitalExpenditures: lineItem(vals.capex),
    },
  };
}

function fyEntry(
  fy: number,
  vals: { revenue: number; netIncome: number; ocf: number; capex: number },
): FinancialsPeriodEntry {
  return {
    fiscalPeriod: `FY${fy}`,
    kind: 'FY',
    fiscalYearEnd: `${fy}-09-28`,
    filed: `${fy}-11-01`,
    formType: '10-K',
    income: {
      revenue: lineItem(vals.revenue),
      netIncome: lineItem(vals.netIncome),
    },
    balance: {
      totalAssets: lineItem(364_980_000_000),
    },
    cashFlow: {
      operatingCashFlow: lineItem(vals.ocf),
      capitalExpenditures: lineItem(vals.capex),
    },
  };
}

// ============================================================================
// Happy path: 4 explicit Q
// ============================================================================

describe('deriveTTM — happy path (4 explicit quarters)', () => {
  it('sums income / cashFlow across 4 quarters, derives freeCashFlow', () => {
    // 模拟 AAPL FY2024 Q3 + Q2 + Q1 + FY2023 Q4 = TTM as of Q3-FY2024
    const periods: FinancialsPeriodEntry[] = [
      quarterEntry(2024, 'Q3', { revenue: 85_000, netIncome: 21_000, ocf: 26_000, capex: 2_000 }),
      quarterEntry(2024, 'Q2', { revenue: 90_000, netIncome: 23_000, ocf: 28_000, capex: 2_100 }),
      quarterEntry(2024, 'Q1', { revenue: 119_000, netIncome: 33_000, ocf: 39_000, capex: 2_500 }),
      quarterEntry(2023, 'Q4', { revenue: 89_000, netIncome: 22_000, ocf: 25_000, capex: 2_200 }),
    ];
    const result = deriveTTM(periods);

    expect(result.skippedReason).toBeUndefined();
    expect(result.ttmEntry).toBeDefined();

    const ttm = result.ttmEntry!;
    expect(ttm.kind).toBe('TTM');
    expect(ttm.fiscalPeriod).toBe('TTM-as-of-Q3-FY2024');
    expect(ttm.formType).toBe('derived-TTM');
    expect(ttm.derivedFromPeriods).toEqual(['Q3-FY2024', 'Q2-FY2024', 'Q1-FY2024', 'Q4-FY2023']);

    expect(ttm.income.revenue?.value).toBe(85_000 + 90_000 + 119_000 + 89_000);
    expect(ttm.income.netIncome?.value).toBe(21_000 + 23_000 + 33_000 + 22_000);
    expect(ttm.cashFlow.operatingCashFlow?.value).toBe(26_000 + 28_000 + 39_000 + 25_000);
    expect(ttm.cashFlow.capitalExpenditures?.value).toBe(2_000 + 2_100 + 2_500 + 2_200);
    expect(ttm.cashFlow.freeCashFlow?.value).toBe(
      ttm.cashFlow.operatingCashFlow!.value - ttm.cashFlow.capitalExpenditures!.value,
    );
    expect(ttm.income.eps).toBeUndefined(); // EPS 不简单加 4 个 Q
  });

  it('balance sheet = latest Q balance (not summed)', () => {
    const latestBalance = { totalAssets: lineItem(364_980_000_000) };
    const periods: FinancialsPeriodEntry[] = [
      { ...quarterEntry(2024, 'Q3', { revenue: 85, netIncome: 21, ocf: 26, capex: 2 }), balance: latestBalance },
      quarterEntry(2024, 'Q2', { revenue: 90, netIncome: 23, ocf: 28, capex: 2 }),
      quarterEntry(2024, 'Q1', { revenue: 119, netIncome: 33, ocf: 39, capex: 2 }),
      quarterEntry(2023, 'Q4', { revenue: 89, netIncome: 22, ocf: 25, capex: 2 }),
    ];
    const { ttmEntry } = deriveTTM(periods);
    expect(ttmEntry?.balance).toEqual(latestBalance);
  });
});

// ============================================================================
// Q4 derivation: 3 Q + 1 FY
// ============================================================================

describe('deriveTTM — Q4 derivation from FY', () => {
  it('derives Q4 from FY minus Q1+Q2+Q3 when no explicit Q4 10-Q exists', () => {
    // 苹果 FY2024 = $391B 营收，Q1+Q2+Q3 = $295.5B，Q4 应 = $95.5B
    const periods: FinancialsPeriodEntry[] = [
      fyEntry(2024, { revenue: 391_000, netIncome: 94_000, ocf: 118_000, capex: 9_500 }),
      quarterEntry(2024, 'Q3', { revenue: 85_000, netIncome: 21_000, ocf: 26_000, capex: 2_000 }),
      quarterEntry(2024, 'Q2', { revenue: 90_000, netIncome: 23_000, ocf: 28_000, capex: 2_100 }),
      quarterEntry(2024, 'Q1', { revenue: 119_000, netIncome: 33_000, ocf: 39_000, capex: 2_500 }),
    ];
    const result = deriveTTM(periods);

    expect(result.skippedReason).toBeUndefined();
    expect(result.ttmEntry).toBeDefined();
    const ttm = result.ttmEntry!;
    expect(ttm.derivedFromPeriods).toEqual(['Q4-FY2024', 'Q3-FY2024', 'Q2-FY2024', 'Q1-FY2024']);
    // 注意：TTM income.revenue = Q4+Q3+Q2+Q1 = FY2024 revenue
    expect(ttm.income.revenue?.value).toBe(391_000);
    expect(ttm.income.netIncome?.value).toBe(94_000);
    expect(ttm.cashFlow.operatingCashFlow?.value).toBe(118_000);
  });

  it('skips when FY missing key line item (cannot derive Q4)', () => {
    const fyNoNetIncome: FinancialsPeriodEntry = {
      ...fyEntry(2024, { revenue: 391_000, netIncome: 0, ocf: 118_000, capex: 9_500 }),
      income: { revenue: lineItem(391_000) }, // 故意丢 netIncome
    };
    const periods: FinancialsPeriodEntry[] = [
      fyNoNetIncome,
      quarterEntry(2024, 'Q3', { revenue: 85, netIncome: 21, ocf: 26, capex: 2 }),
      quarterEntry(2024, 'Q2', { revenue: 90, netIncome: 23, ocf: 28, capex: 2 }),
      quarterEntry(2024, 'Q1', { revenue: 119, netIncome: 33, ocf: 39, capex: 2 }),
    ];
    const result = deriveTTM(periods);
    expect(result.ttmEntry).toBeUndefined();
    expect(result.skippedReason).toMatch(/Q4-FY\d+ derivation failed/);
  });
});

// ============================================================================
// Skipped reasons
// ============================================================================

describe('deriveTTM — skipped reasons', () => {
  it('skips when no quarters at all', () => {
    const periods: FinancialsPeriodEntry[] = [
      fyEntry(2024, { revenue: 391_000, netIncome: 94_000, ocf: 118_000, capex: 9_500 }),
    ];
    const result = deriveTTM(periods);
    expect(result.skippedReason).toMatch(/insufficient quarters: 0\/4/);
  });

  it('skips when only 2 quarters available and no FY for Q4 derivation', () => {
    const periods: FinancialsPeriodEntry[] = [
      quarterEntry(2024, 'Q2', { revenue: 90, netIncome: 23, ocf: 28, capex: 2 }),
      quarterEntry(2024, 'Q1', { revenue: 119, netIncome: 33, ocf: 39, capex: 2 }),
    ];
    const result = deriveTTM(periods);
    // Anchor = Q2-FY2024; target backward includes Q4-FY2023 which can't
    // be reverse-derived (no FY2023 entry in bundle).
    expect(result.skippedReason).toMatch(/Q4-FY2023.*no FY2023 entry/);
  });

  it('skips when 4 quarters not consecutive (data gap)', () => {
    // 缺 Q2-FY2024，Q4-FY2023 + Q1-FY2024 + Q3-FY2024 + Q4-FY2023 重复
    const periods: FinancialsPeriodEntry[] = [
      quarterEntry(2024, 'Q3', { revenue: 85, netIncome: 21, ocf: 26, capex: 2 }),
      // 缺 Q2-FY2024
      quarterEntry(2024, 'Q1', { revenue: 119, netIncome: 33, ocf: 39, capex: 2 }),
      quarterEntry(2023, 'Q4', { revenue: 89, netIncome: 22, ocf: 25, capex: 2 }),
      quarterEntry(2023, 'Q3', { revenue: 80, netIncome: 20, ocf: 23, capex: 2 }),
    ];
    const result = deriveTTM(periods);
    // Anchor = Q3-FY2024; target = [Q3, Q2, Q1-FY2024, Q4-FY2023]. Q2 is
    // the explicit gap before anchor; surfaced verbatim.
    expect(result.skippedReason).toMatch(/Q2-FY2024 missing from bundle/);
  });
});

// ============================================================================
// Unit mismatches (defensive: line items with different units should not sum)
// ============================================================================

describe('deriveTTM — unit handling', () => {
  it('returns undefined line item if quarters have mismatched units (e.g. mid-stream unit change)', () => {
    const q3 = quarterEntry(2024, 'Q3', { revenue: 85, netIncome: 21, ocf: 26, capex: 2 });
    const q2: FinancialsPeriodEntry = {
      ...quarterEntry(2024, 'Q2', { revenue: 90, netIncome: 23, ocf: 28, capex: 2 }),
      income: { revenue: lineItem(90_000_000, 'USD_millions'), netIncome: lineItem(23) }, // 故意改 unit
    };
    const q1 = quarterEntry(2024, 'Q1', { revenue: 119, netIncome: 33, ocf: 39, capex: 2 });
    const q4_2023 = quarterEntry(2023, 'Q4', { revenue: 89, netIncome: 22, ocf: 25, capex: 2 });
    const result = deriveTTM([q3, q2, q1, q4_2023]);

    expect(result.skippedReason).toBeUndefined(); // 整体没 skip
    expect(result.ttmEntry?.income.revenue).toBeUndefined(); // 但 revenue 是空（单位不一致）
    expect(result.ttmEntry?.income.netIncome?.value).toBe(21 + 23 + 33 + 22); // netIncome 还是好的
  });
});
