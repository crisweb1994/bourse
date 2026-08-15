import { describe, expect, it } from 'vitest';
import { OverallConclusion } from '../../contracts/comprehensive-summary';

const valid = {
  headline: '综合看法中性',
  signal: null,
  confidence: 'LOW' as const,
  rationale: [],
  counterpoints: [],
  changeConditions: ['等待估值数据'],
  missingSections: ['VALUATION_SCENARIOS' as const],
  dataAsOf: '2026-01-15',
  disclaimer: '免责声明',
};

describe('OverallConclusion V2', () => {
  it('uses the five-module summary shape', () => {
    expect(OverallConclusion.parse(valid).missingSections).toEqual(['VALUATION_SCENARIOS']);
    expect(OverallConclusion.parse({ ...valid, signal: 'POSITIVE' }).signal).toBe('POSITIVE');
  });

  it('rejects legacy signal names and section types', () => {
    expect(() => OverallConclusion.parse({ ...valid, signal: 'BULLISH' })).toThrow();
    expect(() => OverallConclusion.parse({ ...valid, missingSections: ['FUNDAMENTAL'] })).toThrow();
  });
});
