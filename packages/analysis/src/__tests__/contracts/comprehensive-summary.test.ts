import { describe, expect, it } from 'vitest';
import {
  ComprehensiveSummary,
  SectionSignal,
} from '../../contracts/comprehensive-summary';

const validSummary = {
  overallSignal: 'BULLISH' as const,
  overallConfidence: 'HIGH' as const,
  oneLiner: '综合看好。',
  bullCase: ['理由1', '理由2'],
  bearCase: ['风险1'],
  biggestRisk: '宏观下行',
  valuationConclusion: '估值合理',
  suitableInvestorType: '稳健型',
  watchlistWorthy: true,
  sectionSignals: [
    {
      type: 'FUNDAMENTAL' as const,
      signal: 'BULLISH' as const,
      confidence: 'HIGH' as const,
      oneLiner: '基本面强劲',
    },
  ],
  evidence: [],
  dataAsOf: '2026-05-10',
  disclaimer: '免责声明',
};

describe('contracts/ComprehensiveSummary', () => {
  it('parses minimally valid summary', () => {
    expect(ComprehensiveSummary.parse(validSummary).overallSignal).toBe('BULLISH');
  });

  it('rejects empty oneLiner', () => {
    expect(() =>
      ComprehensiveSummary.parse({ ...validSummary, oneLiner: '' }),
    ).toThrow();
  });

  it('rejects bad dataAsOf format', () => {
    expect(() =>
      ComprehensiveSummary.parse({ ...validSummary, dataAsOf: '2026/05/10' }),
    ).toThrow();
  });

  it('rejects unknown overallSignal', () => {
    expect(() =>
      ComprehensiveSummary.parse({ ...validSummary, overallSignal: 'STRONG_BUY' }),
    ).toThrow();
  });

  it('rejects unknown sectionSignals[].type', () => {
    expect(() =>
      ComprehensiveSummary.parse({
        ...validSummary,
        sectionSignals: [
          { type: 'NOT_A_TYPE', signal: 'BULLISH', confidence: 'HIGH', oneLiner: 'x' },
        ],
      }),
    ).toThrow();
  });
});

describe('contracts/SectionSignal', () => {
  it('rejects empty oneLiner', () => {
    expect(() =>
      SectionSignal.parse({
        type: 'FUNDAMENTAL',
        signal: 'BULLISH',
        confidence: 'HIGH',
        oneLiner: '',
      }),
    ).toThrow();
  });
});
