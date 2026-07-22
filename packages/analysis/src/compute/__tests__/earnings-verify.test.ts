import { describe, expect, it } from 'vitest';
import type { MetricFactCandidate } from '../../contracts/earnings';
import {
  locateSourceSpan,
  verifyEarningsCandidates,
} from '../earnings-verify';

const text = [
  '2026年半年度业绩快报',
  '公司合并口径营业收入为100亿元，同比增长25%。',
  '营业成本为60亿元。',
  '毛利润为40亿元。',
].join('\n');

function candidate(
  metricCode: MetricFactCandidate['metricCode'],
  value: string,
  sourceQuote: string,
): MetricFactCandidate {
  return {
    metricCode,
    value: { kind: 'scalar', value },
    unit: 'currency',
    currency: 'CNY',
    scale: 100_000_000,
    periodStartOn: '2026-01-01',
    periodEndOn: '2026-06-30',
    periodKind: 'duration',
    accumulation: 'YTD',
    accountingBasis: 'CAS',
    consolidationScope: 'consolidated',
    sourceQuote,
  };
}

const derivation = {
  id: 'derivation-1',
  filingId: 'filing-1',
  contentHash: 'a'.repeat(64),
  text,
};

describe('verifyEarningsCandidates', () => {
  it('anchors, normalizes and accepts an internally consistent fact set', () => {
    const result = verifyEarningsCandidates({
      candidates: [
        candidate('revenue', '100', '公司合并口径营业收入为100亿元，同比增长25%。'),
        candidate('costOfRevenue', '60', '营业成本为60亿元。'),
        candidate('grossProfit', '40', '毛利润为40亿元。'),
      ],
      derivation,
      event: { periodEndOn: '2026-06-30', reportingScope: 'consolidated' },
    });
    expect(result.rejected).toEqual([]);
    expect(result.facts).toHaveLength(3);
    expect(result.facts[0].normalizedValue).toEqual({ kind: 'scalar', value: '10000000000' });
    expect(result.facts[0].provenance.kind).toBe('filingSpan');
    expect(result.facts[0].checkStatus).toMatchObject({ status: 'passed' });
  });

  it('rejects scope and period mismatches', () => {
    const wrong = {
      ...candidate('revenue', '100', '公司合并口径营业收入为100亿元，同比增长25%。'),
      periodEndOn: '2026-03-31',
      consolidationScope: 'parent' as const,
    };
    const result = verifyEarningsCandidates({
      candidates: [wrong],
      derivation,
      event: { periodEndOn: '2026-06-30', reportingScope: 'consolidated' },
    });
    expect(result.facts).toEqual([]);
    expect(result.rejected[0].reasons).toEqual(
      expect.arrayContaining(['period_end_mismatch', 'consolidation_scope_mismatch']),
    );
  });

  it('rejects a value that is not present in its source quote without hiding valid facts', () => {
    const result = verifyEarningsCandidates({
      candidates: [
        candidate('revenue', '100', '公司合并口径营业收入为100亿元，同比增长25%。'),
        candidate('costOfRevenue', '60', '营业成本为60亿元。'),
        candidate('grossProfit', '30', '毛利润为40亿元。'),
      ],
      derivation,
      event: { periodEndOn: '2026-06-30', reportingScope: 'consolidated' },
    });
    expect(result.facts).toHaveLength(2);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].candidate?.metricCode).toBe('grossProfit');
    expect(result.rejected[0].reasons).toContain('source_value_mismatch');
  });

  it('rejects an exact source quote that does not name the claimed metric', () => {
    const result = verifyEarningsCandidates({
      candidates: [candidate('netIncomeAttrib', '60', '营业成本为60亿元。')],
      derivation,
      event: { periodEndOn: '2026-06-30', reportingScope: 'consolidated' },
    });
    expect(result.facts).toEqual([]);
    expect(result.rejected[0].reasons).toContain('source_metric_mismatch');
  });

  it('accepts comma-formatted and parenthesized negative source numbers', () => {
    const source = 'Net income attributable to common shareholders was (1,234.50) million.';
    const result = verifyEarningsCandidates({
      candidates: [{
        metricCode: 'netIncomeAttrib',
        value: { kind: 'scalar', value: '-1234.50' },
        unit: 'currency',
        currency: 'USD',
        scale: 1_000_000,
        periodStartOn: '2026-01-01',
        periodEndOn: '2026-03-31',
        periodKind: 'duration',
        accumulation: 'discrete',
        accountingBasis: 'GAAP',
        consolidationScope: 'consolidated',
        sourceQuote: source,
      }],
      derivation: { ...derivation, text: source },
      event: { periodEndOn: '2026-03-31', reportingScope: 'consolidated' },
    });
    expect(result.rejected).toEqual([]);
    expect(result.facts[0].normalizedValue).toEqual({ kind: 'scalar', value: '-1234500000' });
  });

  it('repairs a scalar lower bound when the cited disclosure is an explicit range', () => {
    const source = '归属于上市公司股东的净利润 盈利：873,000 万元–920,000 万元';
    const result = verifyEarningsCandidates({
      candidates: [{
        ...candidate('netIncomeAttrib', '873000', source),
        scale: 10_000,
      }],
      derivation: { ...derivation, text: source },
      event: { periodEndOn: '2026-06-30', reportingScope: 'consolidated' },
    });
    expect(result.rejected).toEqual([]);
    expect(result.facts[0]).toMatchObject({
      value: { kind: 'range', min: '873000', max: '920000' },
      normalizedValue: { kind: 'range', min: '8730000000', max: '9200000000' },
    });
    expect(result.facts[0].checkStatus).toMatchObject({
      checks: expect.arrayContaining(['quoted_range_from_scalar']),
    });
  });

  it('repairs a scalar range written with a spaced ASCII hyphen', () => {
    const source = '基本每股收益 2.2492 元/股 - 2.3703 元/股';
    const result = verifyEarningsCandidates({
      candidates: [{
        ...candidate('epsBasic', '2.2492', source),
        unit: 'per_share',
        scale: 1,
      }],
      derivation: { ...derivation, text: source },
      event: { periodEndOn: '2026-06-30', reportingScope: 'consolidated' },
    });
    expect(result.rejected).toEqual([]);
    expect(result.facts[0].value).toEqual({ kind: 'range', min: '2.2492', max: '2.3703' });
  });

  it('deduplicates identical facts and rejects conflicting duplicates', () => {
    const duplicateText = [
      '合并口径营业收入为100亿元。',
      '财务报表营业收入为100亿元。',
    ].join('\n');
    const duplicates = verifyEarningsCandidates({
      candidates: [
        candidate('revenue', '100', '合并口径营业收入为100亿元。'),
        candidate('revenue', '100', '财务报表营业收入为100亿元。'),
      ],
      derivation: { ...derivation, text: duplicateText },
      event: { periodEndOn: '2026-06-30', reportingScope: 'consolidated' },
    });
    expect(duplicates.facts).toHaveLength(1);
    expect(duplicates.rejected[0].reasons).toContain('duplicate_metric_candidate');

    const conflictText = `${duplicateText}\n更正前营业收入为101亿元。`;
    const conflicts = verifyEarningsCandidates({
      candidates: [
        candidate('revenue', '100', '合并口径营业收入为100亿元。'),
        candidate('revenue', '101', '更正前营业收入为101亿元。'),
      ],
      derivation: { ...derivation, text: conflictText },
      event: { periodEndOn: '2026-06-30', reportingScope: 'consolidated' },
    });
    expect(conflicts.facts).toEqual([]);
    expect(conflicts.rejected).toHaveLength(2);
    expect(conflicts.rejected.every((item) => item.reasons.includes('duplicate_metric_conflict'))).toBe(true);
  });

  it('understands Apple-style gross-margin dollars and capex outflow magnitude', () => {
    const source = [
      'Gross margin 54,781 44,867',
      'Payments for acquisition of property, plant and equipment (4,344) (6,011)',
    ].join('\n');
    const base = {
      unit: 'currency' as const,
      currency: 'USD',
      scale: 1_000_000,
      periodStartOn: '2025-12-28',
      periodEndOn: '2026-03-28',
      periodKind: 'duration' as const,
      accumulation: 'discrete' as const,
      accountingBasis: 'GAAP',
      consolidationScope: 'consolidated' as const,
    };
    const result = verifyEarningsCandidates({
      candidates: [
        { ...base, metricCode: 'grossProfit', value: { kind: 'scalar' as const, value: '54781' }, sourceQuote: 'Gross margin 54,781 44,867' },
        { ...base, metricCode: 'capitalExpenditures', value: { kind: 'scalar' as const, value: '4344' }, sourceQuote: 'Payments for acquisition of property, plant and equipment (4,344) (6,011)' },
      ],
      derivation: { ...derivation, text: source },
      event: { periodEndOn: '2026-03-28', reportingScope: 'consolidated' },
    });
    expect(result.rejected).toEqual([]);
    expect(result.facts).toHaveLength(2);
  });

  it('normalizes GAAP core facts to the explicitly reported three-month quarter', () => {
    const source = [
      'CONDENSED CONSOLIDATED STATEMENTS OF OPERATIONS',
      'Three Months EndedSix Months Ended',
      'March 28, 2026March 29, 2025',
      'Total net sales 111,184 95,359 254,940 219,659',
    ].join('\n');
    const result = verifyEarningsCandidates({
      candidates: [{
        metricCode: 'revenue',
        value: { kind: 'scalar', value: '111184' },
        unit: 'currency',
        currency: 'USD',
        scale: 1_000_000,
        periodStartOn: '2025-09-28',
        periodEndOn: '2026-03-28',
        periodKind: 'duration',
        accumulation: 'FY',
        accountingBasis: 'GAAP',
        consolidationScope: 'consolidated',
        sourceQuote: 'Total net sales 111,184 95,359 254,940 219,659',
      }],
      derivation: { ...derivation, text: source },
      event: {
        periodEndOn: '2026-03-28',
        periodType: 'Q2',
        reportingScope: 'consolidated',
      },
    });

    expect(result.rejected).toEqual([]);
    expect(result.facts[0]).toMatchObject({
      periodStartOn: '2025-12-28',
      accumulation: 'discrete',
      checkStatus: {
        checks: expect.arrayContaining([
          'gaap_quarter_period_start',
          'gaap_quarter_accumulation',
        ]),
      },
    });
  });

  it('clamps a non-month-end fiscal quarter start to the target month end', () => {
    const source = [
      'Three Months Ended',
      'May 29, 2026May 30, 2025',
      'Operating income 2,238 2,109',
    ].join('\n');
    const result = verifyEarningsCandidates({
      candidates: [{
        metricCode: 'operatingIncome',
        value: { kind: 'scalar', value: '2238' },
        unit: 'currency',
        currency: 'USD',
        scale: 1_000_000,
        periodStartOn: '2026-03-01',
        periodEndOn: '2026-05-29',
        periodKind: 'duration',
        accumulation: 'discrete',
        accountingBasis: 'GAAP',
        consolidationScope: 'consolidated',
        sourceQuote: 'Operating income 2,238 2,109',
      }],
      derivation: { ...derivation, text: source },
      event: {
        periodEndOn: '2026-05-29',
        periodType: 'Q2',
        reportingScope: 'consolidated',
      },
    });

    expect(result.rejected).toEqual([]);
    expect(result.facts[0]?.periodStartOn).toBe('2026-02-28');
  });

  it('recognizes common metric labels used in official CN and US statements', () => {
    const source = [
      'Total revenue6,618 5,873',
      '归属于： 本行股东的净 利润 37,852 37,286',
      '资产合计 13,484,882 13,070,523',
      'Operating\nIncome $38,398 $32,000',
      'Net income per diluted share $2.78 $1.59',
      '经营活动产生的现金流量净 额 82,627 53,887',
    ].join('\n');
    const candidates = [
      candidate('revenue', '6618', 'Total revenue6,618 5,873'),
      candidate('netIncomeAttrib', '37852', '归属于： 本行股东的净 利润 37,852 37,286'),
      candidate('totalAssets', '13484882', '资产合计 13,484,882 13,070,523'),
      candidate('operatingIncome', '38398', 'Operating\nIncome $38,398 $32,000'),
      candidate('epsDiluted', '2.78', 'Net income per diluted share $2.78 $1.59'),
      candidate('operatingCashFlow', '82627', '经营活动产生的现金流量净 额 82,627 53,887'),
    ];
    const result = verifyEarningsCandidates({
      candidates,
      derivation: { ...derivation, text: source },
      event: { periodEndOn: '2026-06-30', reportingScope: 'consolidated' },
    });

    expect(result.rejected).toEqual([]);
    expect(result.facts).toHaveLength(6);
  });

  it('normalizes only mechanical model-output variants and CAS Q1 semantics', () => {
    const source = '营业收入（千元） 129,131,041 84,704,589 52.45%';
    const result = verifyEarningsCandidates({
      candidates: [{
        metricCode: 'revenue',
        value: { kind: 'scalar', amount: '129131041' },
        unit: 'currency',
        currency: 'CNY',
        scale: '1000',
        periodEndOn: '2026-03-31',
        periodKind: 'duration',
        accumulation: 'discrete',
        accountingBasis: 'CAS',
        consolidationScope: 'consolidated',
        sourceQuote: source,
        sourcePage: '1',
      }],
      derivation: {
        ...derivation,
        text: source,
        pages: [{ page: 1, startOffset: 0, endOffset: source.length }],
      },
      event: { periodEndOn: '2026-03-31', reportingScope: 'consolidated' },
    });
    expect(result.rejected).toEqual([]);
    expect(result.facts[0]).toMatchObject({
      periodStartOn: '2026-01-01',
      accumulation: 'YTD',
      normalizedValue: { kind: 'scalar', value: '129131041000' },
    });
    expect(result.facts[0].checkStatus).toMatchObject({
      checks: expect.arrayContaining([
        'scalar_amount_to_value',
        'source_page_string_to_integer',
        'cas_q1_period_start',
        'cas_q1_accumulation',
      ]),
    });
  });

  it('normalizes percent-suffixed YoY claims and omits percentage-point changes', () => {
    const source = [
      'Revenue 100 80',
      'Gross margin 74.9% 60.5%',
    ].join('\n');
    const revenue = {
      ...candidate('revenue', '100', 'Revenue 100 80'),
      currency: 'USD',
      scale: 1_000_000,
      claimedYoYPct: '25%',
    };
    const margin = {
      ...candidate('grossMargin', '74.9', 'Gross margin 74.9% 60.5%'),
      unit: 'percent' as const,
      scale: 1,
      currency: null,
      claimedYoYPct: '14.4 pts',
    };
    const result = verifyEarningsCandidates({
      candidates: [revenue, margin],
      derivation: { ...derivation, text: source },
      event: { periodEndOn: '2026-06-30', reportingScope: 'consolidated' },
    });

    expect(result.rejected).toEqual([]);
    expect(result.facts.find((fact) => fact.metricCode === 'revenue')).toMatchObject({
      claimedYoYPct: '25',
      checkStatus: { checks: expect.arrayContaining(['claimed_yoy_percent_to_decimal']) },
    });
    expect(result.facts.find((fact) => fact.metricCode === 'grossMargin')).toMatchObject({
      claimedYoYPct: undefined,
      checkStatus: { checks: expect.arrayContaining(['omit_percentage_point_as_claimed_yoy']) },
    });
  });

  it('does not accept an ambiguous repeated quote without a page hint', () => {
    const repeated = 'Revenue was 10.\nRevenue was 10.';
    expect(locateSourceSpan(repeated, 'Revenue was 10.')).toBeNull();
    expect(
      locateSourceSpan(repeated, 'Revenue was 10.', 2, [
        { page: 1, startOffset: 0, endOffset: 15 },
        { page: 2, startOffset: 16, endOffset: repeated.length },
      ])?.page,
    ).toBe(2);
  });

  it('repairs only harmless page-number variants when the quote is globally unique', () => {
    const source = '营业收入为100亿元。\n营业成本为60亿元。';
    const result = verifyEarningsCandidates({
      candidates: [
        { ...candidate('revenue', '100', '营业收入为100亿元。'), sourcePage: 2 },
        { ...candidate('costOfRevenue', '60', '营业成本为60亿元。'), sourcePage: 0 },
      ],
      derivation: {
        ...derivation,
        text: source,
        pages: [{ page: 1, startOffset: 0, endOffset: source.length }],
      },
      event: { periodEndOn: '2026-06-30', reportingScope: 'consolidated' },
    });
    expect(result.rejected).toEqual([]);
    expect(result.facts[0].checkStatus).toMatchObject({
      checks: expect.arrayContaining(['source_page_corrected_by_unique_quote']),
    });
    expect(result.facts[1].checkStatus).toMatchObject({
      checks: expect.arrayContaining(['omit_nonpositive_source_page']),
    });
  });

  it('requires a page number for facts from a paginated filing', () => {
    const source = '营业收入为100亿元。';
    const result = verifyEarningsCandidates({
      candidates: [candidate('revenue', '100', source)],
      derivation: {
        ...derivation,
        text: source,
        pages: [{ page: 1, startOffset: 0, endOffset: source.length }],
      },
      event: { periodEndOn: '2026-06-30', reportingScope: 'consolidated' },
    });
    expect(result.facts).toEqual([]);
    expect(result.rejected[0]?.reasons).toContain('source_page_required_for_paged_filing');
  });

  it('propagates a period start only when multiple same-period facts agree', () => {
    const missingStart = candidate('revenue', '100', '公司合并口径营业收入为100亿元，同比增长25%。');
    delete (missingStart as Partial<MetricFactCandidate>).periodStartOn;
    const result = verifyEarningsCandidates({
      candidates: [
        missingStart,
        candidate('costOfRevenue', '60', '营业成本为60亿元。'),
        candidate('grossProfit', '40', '毛利润为40亿元。'),
      ],
      derivation,
      event: { periodEndOn: '2026-06-30', reportingScope: 'consolidated' },
    });
    expect(result.rejected).toEqual([]);
    expect(result.facts.find((fact) => fact.metricCode === 'revenue')).toMatchObject({
      periodStartOn: '2026-01-01',
      checkStatus: { checks: expect.arrayContaining(['shared_period_start']) },
    });

    const singleSupport = verifyEarningsCandidates({
      candidates: [missingStart, candidate('costOfRevenue', '60', '营业成本为60亿元。')],
      derivation,
      event: { periodEndOn: '2026-06-30', reportingScope: 'consolidated' },
    });
    expect(singleSupport.rejected.some((item) => item.reasons.includes('schema_invalid'))).toBe(true);
  });

  it('infers a discrete quarter start only from an explicit prior-period end', () => {
    const source = [
      'Three Months Ended',
      'April 26,January 25,',
      '20262026',
      'Revenue was 100 million.',
    ].join('\n');
    const fact = {
      ...candidate('revenue', '100', 'Revenue was 100 million.'),
      currency: 'USD',
      scale: 1_000_000,
      periodEndOn: '2026-04-26',
      accumulation: 'discrete' as const,
    };
    delete (fact as Partial<MetricFactCandidate>).periodStartOn;
    const result = verifyEarningsCandidates({
      candidates: [fact],
      derivation: { ...derivation, text: source },
      event: { periodEndOn: '2026-04-26', reportingScope: 'consolidated' },
    });
    expect(result.rejected).toEqual([]);
    expect(result.facts[0]).toMatchObject({
      periodStartOn: '2026-01-26',
      checkStatus: { checks: expect.arrayContaining(['period_start_from_prior_period_end']) },
    });
  });

  it('normalizes the intrinsic period kind before applying duration checks', () => {
    const wrongKind = {
      ...candidate('revenue', '100', '公司合并口径营业收入为100亿元，同比增长25%。'),
      periodKind: 'instant' as const,
    };
    delete (wrongKind as Partial<MetricFactCandidate>).periodStartOn;
    const result = verifyEarningsCandidates({
      candidates: [wrongKind, candidate('costOfRevenue', '60', '营业成本为60亿元。'), candidate('grossProfit', '40', '毛利润为40亿元。')],
      derivation,
      event: { periodEndOn: '2026-06-30', reportingScope: 'consolidated' },
    });
    expect(result.rejected).toEqual([]);
    expect(result.facts.find((fact) => fact.metricCode === 'revenue')).toMatchObject({
      periodKind: 'duration',
      periodStartOn: '2026-01-01',
      checkStatus: { checks: expect.arrayContaining(['metric_period_kind', 'shared_period_start']) },
    });
  });
});
