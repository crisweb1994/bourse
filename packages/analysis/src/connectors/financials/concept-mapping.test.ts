import { describe, expect, it } from 'vitest';
import {
  INCOME_CONCEPTS,
  BALANCE_CONCEPTS,
  CASHFLOW_CONCEPTS,
  findConcept,
  pickFactForPeriod,
  type XbrlConcept,
} from './concept-mapping';

const usdConcept = (entries: Array<Partial<{ fy: number; fp: string; val: number; filed: string; end: string; form: string }>>): XbrlConcept => ({
  units: {
    USD: entries.map((e) => ({
      end: e.end ?? '2024-09-28',
      val: e.val ?? 0,
      fy: e.fy ?? 2024,
      fp: (e.fp ?? 'FY') as 'FY' | 'Q1' | 'Q2' | 'Q3' | 'Q4',
      form: e.form ?? '10-K',
      filed: e.filed ?? '2024-11-01',
    })),
  },
});

describe('financials/concept-mapping — findConcept', () => {
  it('returns the first matching concept in alternative order', () => {
    const facts = {
      RevenueFromContractWithCustomerExcludingAssessedTax: usdConcept([{ val: 100 }]),
      SalesRevenueNet: usdConcept([{ val: 999 }]),
    };
    // INCOME_CONCEPTS.revenue starts with 'Revenues' (not present here);
    // second alternative is RevenueFromContract... which exists.
    const found = findConcept(facts, INCOME_CONCEPTS.revenue);
    expect(found?.units.USD?.[0]?.val).toBe(100);
  });

  it('returns undefined when none of the alternatives exist', () => {
    const facts = { UnrelatedConcept: usdConcept([{ val: 1 }]) };
    expect(findConcept(facts, INCOME_CONCEPTS.revenue)).toBeUndefined();
  });

  it('returns undefined for empty/missing us-gaap blob', () => {
    expect(findConcept(undefined, INCOME_CONCEPTS.revenue)).toBeUndefined();
    expect(findConcept({}, INCOME_CONCEPTS.revenue)).toBeUndefined();
  });
});

describe('financials/concept-mapping — pickFactForPeriod', () => {
  it('returns the only matching entry for (fy, fp)', () => {
    const concept = usdConcept([
      { fy: 2024, fp: 'FY', val: 391_000_000_000, filed: '2024-11-01' },
      { fy: 2023, fp: 'FY', val: 383_000_000_000, filed: '2023-11-02' },
    ]);
    const got = pickFactForPeriod(concept, { fy: 2024, fp: 'FY' });
    expect(got?.unit).toBe('USD');
    expect(got?.entry.val).toBe(391_000_000_000);
  });

  it('on restatement (multiple entries same fy/fp), picks the latest filed', () => {
    const concept = usdConcept([
      { fy: 2022, fp: 'FY', val: 100, filed: '2022-11-01' },        // 原始
      { fy: 2022, fp: 'FY', val: 95, filed: '2024-03-15' },         // 重述
      { fy: 2022, fp: 'FY', val: 98, filed: '2023-06-10' },         // 中间一次重述
    ]);
    const got = pickFactForPeriod(concept, { fy: 2022, fp: 'FY' });
    expect(got?.entry.val).toBe(95); // 2024-03-15 是最新 filed
  });

  it('returns undefined when no entry matches (fy, fp)', () => {
    const concept = usdConcept([{ fy: 2024, fp: 'FY', val: 1 }]);
    expect(pickFactForPeriod(concept, { fy: 2024, fp: 'Q1' })).toBeUndefined();
    expect(pickFactForPeriod(concept, { fy: 2023, fp: 'FY' })).toBeUndefined();
  });

  it('iterates units (e.g. shares-only concept like shareCount)', () => {
    const concept: XbrlConcept = {
      units: {
        shares: [
          { end: '2024-09-28', val: 15_000_000_000, fy: 2024, fp: 'FY', form: '10-K', filed: '2024-11-01' },
        ],
      },
    };
    const got = pickFactForPeriod(concept, { fy: 2024, fp: 'FY' });
    expect(got?.unit).toBe('shares');
    expect(got?.entry.val).toBe(15_000_000_000);
  });
});

describe('financials/concept-mapping — alternative list sanity', () => {
  it('income concepts cover the 6 mainstream line items', () => {
    expect(Object.keys(INCOME_CONCEPTS).sort()).toEqual([
      'costOfRevenue',
      'eps',
      'grossProfit',
      'netIncome',
      'operatingIncome',
      'revenue',
    ]);
  });

  it('balance concepts cover the 5 mainstream line items', () => {
    expect(Object.keys(BALANCE_CONCEPTS).sort()).toEqual([
      'cashAndCashEquivalents',
      'longTermDebt',
      'totalAssets',
      'totalLiabilities',
      'totalStockholdersEquity',
    ]);
  });

  it('cash flow concepts cover 4 reported items (freeCashFlow is derived, not in map)', () => {
    expect(Object.keys(CASHFLOW_CONCEPTS).sort()).toEqual([
      'capitalExpenditures',
      'financingCashFlow',
      'investingCashFlow',
      'operatingCashFlow',
    ]);
  });

  it('all alternative arrays are non-empty', () => {
    for (const m of [INCOME_CONCEPTS, BALANCE_CONCEPTS, CASHFLOW_CONCEPTS]) {
      for (const [k, alternatives] of Object.entries(m)) {
        expect(alternatives.length, `${k} must have ≥1 alternative`).toBeGreaterThan(0);
      }
    }
  });
});
