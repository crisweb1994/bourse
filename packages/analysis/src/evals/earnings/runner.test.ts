import { describe, expect, it } from 'vitest';
import { runEarningsEval } from './runner';

const text = '公司合并口径营业收入为100亿元。归母净利润为20亿元。';

function baseCandidate(metricCode: 'revenue' | 'netIncomeAttrib', value: string, quote: string) {
  return {
    metricCode,
    value: { kind: 'scalar' as const, value },
    unit: 'currency' as const,
    currency: 'CNY',
    scale: 100_000_000,
    periodStartOn: '2026-01-01',
    periodEndOn: '2026-06-30',
    periodKind: 'duration' as const,
    accumulation: 'YTD' as const,
    accountingBasis: 'CAS',
    consolidationScope: 'consolidated' as const,
    sourceQuote: quote,
  };
}

function gold(metricCode: 'revenue' | 'netIncomeAttrib', value: string) {
  return {
    metricCode,
    normalizedValue: { kind: 'scalar' as const, value },
    unit: 'currency',
    currency: 'CNY',
    periodStartOn: '2026-01-01',
    periodEndOn: '2026-06-30',
    accumulation: 'YTD' as const,
    accountingBasis: 'CAS',
    consolidationScope: 'consolidated' as const,
    sourceQuote: metricCode === 'revenue'
      ? '公司合并口径营业收入为100亿元。'
      : '归母净利润为20亿元。',
    eligible: true,
  };
}

describe('runEarningsEval', () => {
  it('reports precision, coverage, false acceptance and confidence bound', () => {
    const result = runEarningsEval([{
      meta: { id: 'CN_TEST', market: 'CN', split: 'blind', formType: 'preliminary' },
      derivation: {
        id: 'd1',
        filingId: 'f1',
        contentHash: 'a'.repeat(64),
        text: text.replace('归母净利润为20亿元。', '归母净利润为21亿元。'),
      },
      event: { periodEndOn: '2026-06-30', reportingScope: 'consolidated' },
      candidates: [
        baseCandidate('revenue', '100', '公司合并口径营业收入为100亿元。'),
        baseCandidate('netIncomeAttrib', '21', '归母净利润为21亿元。'),
      ],
      goldFacts: [gold('revenue', '10000000000'), gold('netIncomeAttrib', '2000000000')],
    }]);
    expect(result.metrics.visibleFacts).toBe(2);
    expect(result.metrics.correctVisibleFacts).toBe(1);
    expect(result.metrics.falseAcceptedFacts).toBe(1);
    expect(result.metrics.coverage).toBe(0.5);
    expect(result.metrics.visiblePrecision).toBe(0.5);
    expect(result.metrics.falseAcceptanceUpper95).toBeGreaterThan(0.5);
    expect(result.splits.blind.documents).toBe(1);
    expect(result.gate.passed).toBe(false);
    expect(result.strata).toHaveLength(1);
  });

  it('counts an in-scope metric with the wrong period identity as false acceptance', () => {
    const candidate = baseCandidate('revenue', '100', '公司合并口径营业收入为100亿元。');
    candidate.periodStartOn = '2026-04-01';
    const result = runEarningsEval([{
      meta: { id: 'CN_WRONG_PERIOD', market: 'CN', split: 'blind', formType: 'preliminary' },
      derivation: { id: 'd1', filingId: 'f1', contentHash: 'a'.repeat(64), text },
      event: { periodEndOn: '2026-06-30', reportingScope: 'consolidated' },
      candidates: [candidate],
      goldFacts: [gold('revenue', '10000000000')],
    }]);

    expect(result.metrics.visibleFacts).toBe(1);
    expect(result.metrics.correctVisibleFacts).toBe(0);
    expect(result.metrics.falseAcceptedFacts).toBe(1);
  });
});
