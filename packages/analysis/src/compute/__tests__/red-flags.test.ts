import { describe, expect, it } from 'vitest';
import type {
  FinancialsBundle,
  FinancialsPeriodEntry,
} from '../..';
import { detectRedFlags } from '../red-flags';

function fy(
  period: string,
  data: {
    revenue?: number;
    grossProfit?: number;
    netIncome?: number;
    operatingIncome?: number;
    interestExpense?: number;
    totalAssets?: number;
    totalEquity?: number;
    accountsReceivable?: number;
    goodwill?: number;
    operatingCashFlow?: number;
    freeCashFlow?: number;
  },
): FinancialsPeriodEntry {
  const usd = (v: number | undefined) =>
    v !== undefined ? { value: v, unit: 'USD' } : undefined;
  return {
    fiscalPeriod: period,
    kind: 'FY',
    fiscalYearEnd: '2024-12-31',
    filed: '2025-01-31',
    income: {
      revenue: usd(data.revenue),
      grossProfit: usd(data.grossProfit),
      netIncome: usd(data.netIncome),
      operatingIncome: usd(data.operatingIncome),
      interestExpense: usd(data.interestExpense),
    },
    balance: {
      totalAssets: usd(data.totalAssets),
      totalStockholdersEquity: usd(data.totalEquity),
      accountsReceivable: usd(data.accountsReceivable),
      goodwill: usd(data.goodwill),
    },
    cashFlow: {
      operatingCashFlow: usd(data.operatingCashFlow),
      freeCashFlow: usd(data.freeCashFlow),
    },
  };
}

function bundle(periods: FinancialsPeriodEntry[]): FinancialsBundle {
  return {
    periods,
    currency: 'USD',
    sourceUrl: 'https://example.com',
    retrievedAt: '2025-05-25T00:00:00.000Z',
    provider: 'test',
    qualityTier: 'A',
  };
}

describe('red-flags · null safety', () => {
  it('returns empty array for null bundle', () => {
    expect(detectRedFlags({ bundle: null, ratios: null })).toEqual([]);
  });

  it('returns empty array when bundle has only 1 FY (most rules need ≥2)', () => {
    const b = bundle([fy('FY2024', { revenue: 100, netIncome: 10, totalAssets: 500, totalEquity: 200 })]);
    const flags = detectRedFlags({ bundle: b, ratios: null });
    expect(flags).toEqual([]);
  });
});

describe('red-flags · accrual_high (Sloan)', () => {
  it('flags when (NI - OCF) / TA > 0.10 for 2 consecutive years', () => {
    // NI=15, OCF=5 → (15-5)/50 = 0.20 > 0.10
    const b = bundle([
      fy('FY2024', { netIncome: 15, operatingCashFlow: 5, totalAssets: 50, totalEquity: 25 }),
      fy('FY2023', { netIncome: 14, operatingCashFlow: 4, totalAssets: 48, totalEquity: 24 }),
    ]);
    const flags = detectRedFlags({ bundle: b, ratios: null });
    expect(flags.some((f) => f.rule === 'accrual_high')).toBe(true);
  });

  it('does NOT flag when only the latest year is high', () => {
    const b = bundle([
      fy('FY2024', { netIncome: 15, operatingCashFlow: 5, totalAssets: 50, totalEquity: 25 }),
      fy('FY2023', { netIncome: 10, operatingCashFlow: 9, totalAssets: 48, totalEquity: 24 }),
    ]);
    expect(detectRedFlags({ bundle: b, ratios: null }).some((f) => f.rule === 'accrual_high')).toBe(false);
  });

  it('does NOT flag clean books (NI ≈ OCF)', () => {
    const b = bundle([
      fy('FY2024', { netIncome: 10, operatingCashFlow: 11, totalAssets: 50, totalEquity: 25 }),
      fy('FY2023', { netIncome: 9, operatingCashFlow: 10, totalAssets: 48, totalEquity: 24 }),
    ]);
    expect(detectRedFlags({ bundle: b, ratios: null }).some((f) => f.rule === 'accrual_high')).toBe(false);
  });
});

describe('red-flags · fcf_ni_divergence', () => {
  it('flags positive NI but negative FCF in 2 consecutive years', () => {
    const b = bundle([
      fy('FY2024', { netIncome: 100, freeCashFlow: -50, totalAssets: 1000, totalEquity: 400 }),
      fy('FY2023', { netIncome: 80, freeCashFlow: -30, totalAssets: 900, totalEquity: 380 }),
    ]);
    const flags = detectRedFlags({ bundle: b, ratios: null });
    const flag = flags.find((f) => f.rule === 'fcf_ni_divergence');
    expect(flag).toBeDefined();
    expect(flag?.severity).toBe('high');
    expect(flag?.category).toBe('cash_flow');
  });

  it('does NOT flag when FCF is positive', () => {
    const b = bundle([
      fy('FY2024', { netIncome: 100, freeCashFlow: 80, totalAssets: 1000, totalEquity: 400 }),
      fy('FY2023', { netIncome: 80, freeCashFlow: 70, totalAssets: 900, totalEquity: 380 }),
    ]);
    expect(detectRedFlags({ bundle: b, ratios: null }).some((f) => f.rule === 'fcf_ni_divergence')).toBe(false);
  });

  it('does NOT flag if NI is negative (then it is not "earnings without cash")', () => {
    const b = bundle([
      fy('FY2024', { netIncome: -10, freeCashFlow: -50, totalAssets: 1000, totalEquity: 400 }),
      fy('FY2023', { netIncome: -5, freeCashFlow: -30, totalAssets: 900, totalEquity: 380 }),
    ]);
    expect(detectRedFlags({ bundle: b, ratios: null }).some((f) => f.rule === 'fcf_ni_divergence')).toBe(false);
  });
});

describe('red-flags · revenue_stalling', () => {
  it('flags 2 consecutive YoY revenue declines', () => {
    const b = bundle([
      fy('FY2024', { revenue: 80, netIncome: 5, totalAssets: 500, totalEquity: 200 }),
      fy('FY2023', { revenue: 90, netIncome: 8, totalAssets: 480, totalEquity: 195 }),
      fy('FY2022', { revenue: 100, netIncome: 10, totalAssets: 460, totalEquity: 190 }),
    ]);
    expect(detectRedFlags({ bundle: b, ratios: null }).some((f) => f.rule === 'revenue_stalling')).toBe(true);
  });

  it('does NOT flag a 1-year dip after growth', () => {
    const b = bundle([
      fy('FY2024', { revenue: 95, netIncome: 8, totalAssets: 500, totalEquity: 200 }),
      fy('FY2023', { revenue: 100, netIncome: 10, totalAssets: 480, totalEquity: 195 }),
      fy('FY2022', { revenue: 80, netIncome: 6, totalAssets: 460, totalEquity: 190 }),
    ]);
    expect(detectRedFlags({ bundle: b, ratios: null }).some((f) => f.rule === 'revenue_stalling')).toBe(false);
  });
});

describe('red-flags · gross_margin_drop', () => {
  it('flags drop > 5 percentage points YoY', () => {
    const b = bundle([
      fy('FY2024', { revenue: 100, grossProfit: 30, netIncome: 5, totalAssets: 500, totalEquity: 200 }), // 30%
      fy('FY2023', { revenue: 100, grossProfit: 40, netIncome: 8, totalAssets: 480, totalEquity: 195 }), // 40%
    ]);
    const flag = detectRedFlags({ bundle: b, ratios: null }).find((f) => f.rule === 'gross_margin_drop');
    expect(flag).toBeDefined();
    expect(flag?.evidence.drop).toBeCloseTo(0.1, 4);
  });

  it('does NOT flag drop < 5pp', () => {
    const b = bundle([
      fy('FY2024', { revenue: 100, grossProfit: 38, netIncome: 5, totalAssets: 500, totalEquity: 200 }),
      fy('FY2023', { revenue: 100, grossProfit: 40, netIncome: 8, totalAssets: 480, totalEquity: 195 }),
    ]);
    expect(detectRedFlags({ bundle: b, ratios: null }).some((f) => f.rule === 'gross_margin_drop')).toBe(false);
  });
});

describe('red-flags · roe_drop', () => {
  it('flags ROE drop > 10pp', () => {
    // FY2024 ROE = 10/100 = 10% ; FY2023 ROE = 30/100 = 30% ; drop = 20pp
    const b = bundle([
      fy('FY2024', { netIncome: 10, totalEquity: 100, totalAssets: 500 }),
      fy('FY2023', { netIncome: 30, totalEquity: 100, totalAssets: 480 }),
    ]);
    const flag = detectRedFlags({ bundle: b, ratios: null }).find((f) => f.rule === 'roe_drop');
    expect(flag).toBeDefined();
    expect(flag?.evidence.drop).toBeCloseTo(0.2, 4);
  });

  it('does NOT flag small ROE wobble', () => {
    const b = bundle([
      fy('FY2024', { netIncome: 18, totalEquity: 100, totalAssets: 500 }),
      fy('FY2023', { netIncome: 22, totalEquity: 100, totalAssets: 480 }),
    ]);
    expect(detectRedFlags({ bundle: b, ratios: null }).some((f) => f.rule === 'roe_drop')).toBe(false);
  });
});

describe('red-flags · multiple rules co-fire', () => {
  it('flags both fcf_ni_divergence and revenue_stalling when both true', () => {
    // Revenue declining + positive NI but negative FCF
    const b = bundle([
      fy('FY2024', { revenue: 80, netIncome: 50, freeCashFlow: -30, totalAssets: 500, totalEquity: 200 }),
      fy('FY2023', { revenue: 90, netIncome: 55, freeCashFlow: -20, totalAssets: 480, totalEquity: 195 }),
      fy('FY2022', { revenue: 100, netIncome: 60, freeCashFlow: -10, totalAssets: 460, totalEquity: 190 }),
    ]);
    const rules = detectRedFlags({ bundle: b, ratios: null }).map((f) => f.rule);
    expect(rules).toContain('fcf_ni_divergence');
    expect(rules).toContain('revenue_stalling');
  });
});

describe('red-flags · ar_outpacing (Beneish DSRI proxy)', () => {
  it('flags when AR YoY > 2 × Revenue YoY (both positive)', () => {
    // Revenue grows 10%, AR grows 30% → 30% > 2 × 10%
    const b = bundle([
      fy('FY2024', { revenue: 110, accountsReceivable: 26, netIncome: 10, totalAssets: 200, totalEquity: 100 }),
      fy('FY2023', { revenue: 100, accountsReceivable: 20, netIncome: 9, totalAssets: 195, totalEquity: 98 }),
    ]);
    expect(detectRedFlags({ bundle: b, ratios: null }).some((f) => f.rule === 'ar_outpacing')).toBe(true);
  });

  it('does NOT flag when AR grows in line with revenue', () => {
    const b = bundle([
      fy('FY2024', { revenue: 110, accountsReceivable: 22, totalAssets: 200, totalEquity: 100 }),
      fy('FY2023', { revenue: 100, accountsReceivable: 20, totalAssets: 195, totalEquity: 98 }),
    ]);
    expect(detectRedFlags({ bundle: b, ratios: null }).some((f) => f.rule === 'ar_outpacing')).toBe(false);
  });

  it('does NOT flag when revenue is shrinking (different signal — covered by revenue_stalling)', () => {
    const b = bundle([
      fy('FY2024', { revenue: 90, accountsReceivable: 26, totalAssets: 200, totalEquity: 100 }),
      fy('FY2023', { revenue: 100, accountsReceivable: 20, totalAssets: 195, totalEquity: 98 }),
    ]);
    expect(detectRedFlags({ bundle: b, ratios: null }).some((f) => f.rule === 'ar_outpacing')).toBe(false);
  });

  it('silently skips when AR is unavailable', () => {
    const b = bundle([
      fy('FY2024', { revenue: 110, totalAssets: 200, totalEquity: 100 }),
      fy('FY2023', { revenue: 100, totalAssets: 195, totalEquity: 98 }),
    ]);
    expect(detectRedFlags({ bundle: b, ratios: null }).some((f) => f.rule === 'ar_outpacing')).toBe(false);
  });
});

describe('red-flags · goodwill_concentration', () => {
  it('flags when goodwill / total assets > 30%', () => {
    const b = bundle([
      fy('FY2024', { goodwill: 40, totalAssets: 100, totalEquity: 50 }),
    ]);
    const flags = detectRedFlags({ bundle: b, ratios: null });
    const flag = flags.find((f) => f.rule === 'goodwill_concentration');
    expect(flag).toBeDefined();
    expect(flag!.severity).toBe('high');
  });

  it('does NOT flag at exactly 30% (strict gt)', () => {
    const b = bundle([
      fy('FY2024', { goodwill: 30, totalAssets: 100, totalEquity: 50 }),
    ]);
    expect(detectRedFlags({ bundle: b, ratios: null }).some((f) => f.rule === 'goodwill_concentration')).toBe(false);
  });

  it('silently skips when goodwill missing (most companies)', () => {
    const b = bundle([
      fy('FY2024', { totalAssets: 100, totalEquity: 50 }),
    ]);
    expect(detectRedFlags({ bundle: b, ratios: null }).some((f) => f.rule === 'goodwill_concentration')).toBe(false);
  });
});

describe('red-flags · interest_coverage_low', () => {
  it('flags when OperatingIncome / InterestExpense < 2.0', () => {
    // OpInc=10, InterestExp=8 → coverage=1.25 < 2
    const b = bundle([
      fy('FY2024', { operatingIncome: 10, interestExpense: 8, totalAssets: 200, totalEquity: 50 }),
    ]);
    const flag = detectRedFlags({ bundle: b, ratios: null }).find((f) => f.rule === 'interest_coverage_low');
    expect(flag).toBeDefined();
    expect(flag!.evidence.coverage).toBeCloseTo(1.25, 2);
  });

  it('does NOT flag when coverage ≥ 2x', () => {
    const b = bundle([
      fy('FY2024', { operatingIncome: 20, interestExpense: 8, totalAssets: 200, totalEquity: 50 }),
    ]);
    expect(detectRedFlags({ bundle: b, ratios: null }).some((f) => f.rule === 'interest_coverage_low')).toBe(false);
  });

  it('does NOT flag when operating income is negative (different signal)', () => {
    const b = bundle([
      fy('FY2024', { operatingIncome: -5, interestExpense: 8, totalAssets: 200, totalEquity: 50 }),
    ]);
    expect(detectRedFlags({ bundle: b, ratios: null }).some((f) => f.rule === 'interest_coverage_low')).toBe(false);
  });

  it('silently skips when interest expense missing (cash-rich tech / banks)', () => {
    const b = bundle([
      fy('FY2024', { operatingIncome: 10, totalAssets: 200, totalEquity: 50 }),
    ]);
    expect(detectRedFlags({ bundle: b, ratios: null }).some((f) => f.rule === 'interest_coverage_low')).toBe(false);
  });
});

describe('red-flags · evidence integrity', () => {
  it('every flag has rule / severity / category / title / description / evidence', () => {
    const b = bundle([
      fy('FY2024', { netIncome: 15, operatingCashFlow: 5, totalAssets: 50, totalEquity: 25 }),
      fy('FY2023', { netIncome: 14, operatingCashFlow: 4, totalAssets: 48, totalEquity: 24 }),
    ]);
    const flags = detectRedFlags({ bundle: b, ratios: null });
    for (const f of flags) {
      expect(typeof f.rule).toBe('string');
      expect(['high', 'medium', 'low']).toContain(f.severity);
      expect(['accounting', 'cash_flow', 'valuation', 'governance']).toContain(f.category);
      expect(f.title.length).toBeGreaterThan(0);
      expect(f.description.length).toBeGreaterThan(0);
      expect(typeof f.evidence).toBe('object');
    }
  });
});
