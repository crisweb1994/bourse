import { describe, expect, it } from 'vitest';
import type {
  FinancialsBundle,
  FinancialsPeriodEntry,
  PriceBar,
  Quote,
} from '../..';
import {
  __test,
  computeValuation,
} from '../valuation-helpers';

const { dcfPresentValue, solveImpliedGrowth, pickAssumedGrowth, priceOnOrBefore } = __test;

// ============================================================================
// Fixtures
// ============================================================================

function bar(date: string, close: number): PriceBar {
  return { timestamp: date, open: close, high: close, low: close, close, volume: 1_000_000 };
}

function fy(
  period: string,
  fiscalYearEnd: string,
  data: {
    eps?: number;
    netIncome?: number;
    revenue?: number;
    freeCashFlow?: number;
    totalLiabilities?: number;
    cash?: number;
    totalEquity?: number;
    totalAssets?: number;
  },
): FinancialsPeriodEntry {
  return {
    fiscalPeriod: period,
    kind: 'FY',
    fiscalYearEnd,
    filed: fiscalYearEnd,
    income: {
      revenue: data.revenue !== undefined ? { value: data.revenue, unit: 'USD' } : undefined,
      netIncome: data.netIncome !== undefined ? { value: data.netIncome, unit: 'USD' } : undefined,
      eps: data.eps !== undefined ? { value: data.eps, unit: 'USD/shares' } : undefined,
    },
    balance: {
      totalAssets: data.totalAssets !== undefined ? { value: data.totalAssets, unit: 'USD' } : undefined,
      totalLiabilities:
        data.totalLiabilities !== undefined ? { value: data.totalLiabilities, unit: 'USD' } : undefined,
      totalStockholdersEquity:
        data.totalEquity !== undefined ? { value: data.totalEquity, unit: 'USD' } : undefined,
      cashAndCashEquivalents: data.cash !== undefined ? { value: data.cash, unit: 'USD' } : undefined,
    },
    cashFlow: {
      freeCashFlow:
        data.freeCashFlow !== undefined ? { value: data.freeCashFlow, unit: 'USD' } : undefined,
    },
  };
}

function ttm(data: Parameters<typeof fy>[2]): FinancialsPeriodEntry {
  return { ...fy('TTM', '2025-03-31', data), kind: 'TTM' };
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

function quote(price: number, marketCap: number): Quote {
  return {
    instrument: { instrumentId: 'US:TEST', market: 'US', symbol: 'TEST' },
    price,
    currency: 'USD',
    timestamp: '2025-05-25T00:00:00.000Z',
    marketCap,
  };
}

// ============================================================================
// DCF primitive tests
// ============================================================================

describe('valuation-helpers · dcfPresentValue', () => {
  it('higher growth → higher present value', () => {
    const pvLow = dcfPresentValue(100, 0, 0.1, 0.03, 10);
    const pvHigh = dcfPresentValue(100, 0.1, 0.1, 0.03, 10);
    expect(pvHigh).toBeGreaterThan(pvLow);
  });

  it('higher WACC → lower present value', () => {
    const pvLowWacc = dcfPresentValue(100, 0.05, 0.08, 0.03, 10);
    const pvHighWacc = dcfPresentValue(100, 0.05, 0.12, 0.03, 10);
    expect(pvLowWacc).toBeGreaterThan(pvHighWacc);
  });

  it('zero growth produces a finite, positive PV', () => {
    const pv = dcfPresentValue(100, 0, 0.1, 0.03, 10);
    expect(pv).toBeGreaterThan(0);
    expect(Number.isFinite(pv)).toBe(true);
  });
});

describe('valuation-helpers · solveImpliedGrowth', () => {
  it('round-trips: PV(g*) ≈ marketCap', () => {
    const fcf0 = 1_000_000;
    const dcfAssumptions = { wacc: 0.1, terminalGrowth: 0.03, forecastYears: 10 };
    const targetMarketCap = dcfPresentValue(fcf0, 0.07, 0.1, 0.03, 10);
    const warnings: import('../types').ComputeWarning[] = [];
    const g = solveImpliedGrowth(targetMarketCap, fcf0, dcfAssumptions, warnings);
    expect(g).toBeCloseTo(0.07, 4);
  });

  it('clamps at +50% when market cap exceeds even most-optimistic PV', () => {
    const dcfAssumptions = { wacc: 0.1, terminalGrowth: 0.03, forecastYears: 10 };
    const g = solveImpliedGrowth(1e18, 100, dcfAssumptions, []);
    expect(g).toBe(0.5);
  });

  it('clamps at -50% when market cap is below most-pessimistic PV', () => {
    const dcfAssumptions = { wacc: 0.1, terminalGrowth: 0.03, forecastYears: 10 };
    const g = solveImpliedGrowth(1, 1_000_000, dcfAssumptions, []);
    expect(g).toBe(-0.5);
  });

  it('returns null + warning when WACC ≤ terminal growth', () => {
    const warnings: import('../types').ComputeWarning[] = [];
    const g = solveImpliedGrowth(1e9, 1e8, { wacc: 0.03, terminalGrowth: 0.03, forecastYears: 10 }, warnings);
    expect(g).toBeNull();
    expect(warnings.some((w) => w.metric === 'impliedGrowthRate')).toBe(true);
  });
});

describe('valuation-helpers · pickAssumedGrowth', () => {
  it('haircuts consensus growth by 20%', () => {
    expect(pickAssumedGrowth(0.15)).toBeCloseTo(0.12, 6);
  });

  it('returns default 5% when consensus missing', () => {
    expect(pickAssumedGrowth(null)).toBe(0.05);
    expect(pickAssumedGrowth(undefined)).toBe(0.05);
  });
});

describe('valuation-helpers · priceOnOrBefore', () => {
  const history = [
    bar('2024-12-15', 100),
    bar('2024-12-30', 110),
    bar('2025-01-15', 120),
  ];

  it('returns last bar ≤ target date', () => {
    expect(priceOnOrBefore(history, '2024-12-31')).toBe(110);
    expect(priceOnOrBefore(history, '2025-01-15')).toBe(120);
    expect(priceOnOrBefore(history, '2025-02-01')).toBe(120);
  });

  it('returns null when no bar is ≤ target', () => {
    expect(priceOnOrBefore(history, '2024-01-01')).toBeNull();
  });
});

// ============================================================================
// Integration: computeValuation
// ============================================================================

describe('computeValuation · PE history series', () => {
  it('builds PE series by matching FY EPS with closes on/before fiscalYearEnd', () => {
    const b = bundle([
      ttm({ netIncome: 200, freeCashFlow: 180, eps: 2 }),
      fy('FY2024', '2024-12-31', { eps: 1.9, netIncome: 190 }),
      fy('FY2023', '2023-12-31', { eps: 1.5, netIncome: 150 }),
      fy('FY2022', '2022-12-31', { eps: 1.2, netIncome: 120 }),
    ]);
    const history = [
      bar('2022-12-30', 24), // PE = 24 / 1.2 = 20
      bar('2023-12-29', 36), // PE = 36 / 1.5 = 24
      bar('2024-12-31', 38), // PE = 38 / 1.9 = 20
    ];
    const { valuation } = computeValuation({
      bundle: b,
      quote: quote(40, 4_000),
      history,
      market: 'US',
    });
    expect(valuation!.peHistorySeries).toHaveLength(3);
    expect(valuation!.peHistorySeries[0]!.pe).toBeCloseTo(20, 4);
    expect(valuation!.pe5yLow).toBeCloseTo(20, 4);
    expect(valuation!.pe5yHigh).toBeCloseTo(24, 4);
  });

  it('returns null PE stats when history is absent', () => {
    const b = bundle([
      ttm({ netIncome: 200, freeCashFlow: 180 }),
      fy('FY2024', '2024-12-31', { eps: 1.9 }),
    ]);
    const { valuation, warnings } = computeValuation({
      bundle: b,
      quote: quote(40, 4_000),
      history: null,
      market: 'US',
    });
    expect(valuation!.pe5yPercentile).toBeNull();
    expect(valuation!.peHistorySeries).toEqual([]);
    expect(warnings.some((w) => w.metric === 'pe5yPercentile')).toBe(true);
  });

  it('computes percentile: current PE above all history → 100', () => {
    // current PE = MC / NI = 100 / 1 = 100; all history PE = 10
    const b = bundle([
      ttm({ netIncome: 1, freeCashFlow: 1, eps: 1 }),
      fy('FY2024', '2024-12-31', { eps: 1 }),
      fy('FY2023', '2023-12-31', { eps: 1 }),
      fy('FY2022', '2022-12-31', { eps: 1 }),
    ]);
    const history = [
      bar('2022-12-30', 10),
      bar('2023-12-29', 10),
      bar('2024-12-31', 10),
    ];
    const { valuation } = computeValuation({
      bundle: b,
      quote: quote(100, 100),
      history,
      market: 'US',
    });
    expect(valuation!.pe5yPercentile).toBe(100);
  });
});

describe('computeValuation · reverse DCF + fair value', () => {
  it('produces a sane implied growth for a profitable name', () => {
    const fcf = 100_000;
    const dcfAssumptions = { wacc: 0.1, terminalGrowth: 0.03, forecastYears: 10 };
    const mc = dcfPresentValue(fcf, 0.08, 0.1, 0.03, 10);
    const b = bundle([
      ttm({ freeCashFlow: fcf, netIncome: 80_000, eps: 1, totalLiabilities: 0, cash: 0 }),
    ]);
    const { valuation } = computeValuation({
      bundle: b,
      quote: quote(50, mc),
      history: null,
      market: 'US',
      dcfAssumptions,
    });
    expect(valuation!.impliedGrowthRate).toBeCloseTo(0.08, 3);
  });

  it('computes fair value per share with assumed growth, derives upside', () => {
    const fcf = 100_000;
    const b = bundle([
      ttm({ freeCashFlow: fcf, netIncome: 80_000, eps: 1, totalLiabilities: 0, cash: 0 }),
    ]);
    const { valuation } = computeValuation({
      bundle: b,
      quote: quote(50, 1_000_000), // MC = 1M, shares = 20K
      history: null,
      market: 'US',
      consensusEpsGrowth: 0.1, // → assumed 8%
    });
    expect(valuation!.fairValuePerShare).not.toBeNull();
    expect(valuation!.fairValueAssumedGrowth).toBeCloseTo(0.08, 4);
    expect(valuation!.upside).not.toBeNull();
  });

  it('returns null implied growth when FCF is non-positive', () => {
    const b = bundle([
      ttm({ freeCashFlow: -1_000, netIncome: -2_000, eps: -0.5 }),
    ]);
    const { valuation } = computeValuation({
      bundle: b,
      quote: quote(50, 1_000_000),
      history: null,
      market: 'US',
    });
    expect(valuation!.impliedGrowthRate).toBeNull();
    expect(valuation!.fairValuePerShare).toBeNull();
  });
});

describe('computeValuation · CN unit normalization (regression)', () => {
  it('handles 万元 financials + 亿元 marketCap consistently', () => {
    // Mock Maotai shape: marketCap=21000亿元, FCF=80,000,000万元 = 800B元
    const b: FinancialsBundle = {
      periods: [
        {
          fiscalPeriod: 'TTM',
          kind: 'TTM',
          fiscalYearEnd: '2025-03-31',
          filed: '2025-04-30',
          income: {
            netIncome: { value: 8_572_000, unit: '万元' },
            eps: { value: 68, unit: '元' },
          },
          balance: {
            totalLiabilities: { value: 5_000_000, unit: '万元' },
            cashAndCashEquivalents: { value: 18_000_000, unit: '万元' },
          },
          cashFlow: {
            freeCashFlow: { value: 6_500_000, unit: '万元' },
          },
        },
      ],
      currency: 'CNY',
      sourceUrl: 'https://example.com',
      retrievedAt: '2025-05-25T00:00:00.000Z',
      provider: 'test',
      qualityTier: 'B',
    };
    const cnQuote: Quote = {
      instrument: { instrumentId: 'CN:600519', market: 'CN', symbol: '600519' },
      price: 1685,
      currency: 'CNY',
      timestamp: '2025-05-25T00:00:00.000Z',
      marketCap: 21_000, // 亿元
    };
    const { valuation } = computeValuation({
      bundle: b,
      quote: cnQuote,
      history: null,
      market: 'CN',
    });
    expect(valuation!.baseCurrency).toBe('CNY');
    expect(valuation!.marketCap).toBe(2_100_000_000_000); // 2.1 万亿
    expect(valuation!.enterpriseValue).toBeGreaterThan(0);
  });
});

describe('computeValuation · null safety', () => {
  it('returns null valuation when no inputs produce any number', () => {
    const { valuation } = computeValuation({
      bundle: null,
      quote: null,
      history: null,
      market: 'US',
    });
    expect(valuation).toBeNull();
  });
});
