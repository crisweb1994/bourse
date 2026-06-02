import { describe, expect, it } from 'vitest';
import {
  AnalysisType,
  Confidence,
  Recommendation,
  RunStatus,
  Signal,
} from '../../contracts/enums';

describe('contracts/enums', () => {
  describe('RunStatus', () => {
    it('accepts all 7 superset states', () => {
      for (const s of [
        'PENDING',
        'IN_PROGRESS',
        'COMPLETED',
        'PARTIAL_FAILED',
        'FAILED',
        'CANCELLED',
        'BUDGET_EXHAUSTED',
      ]) {
        expect(RunStatus.parse(s)).toBe(s);
      }
    });

    it('rejects unknown status', () => {
      expect(() => RunStatus.parse('DONE')).toThrow();
    });
  });

  describe('Recommendation', () => {
    it('accepts BUY / HOLD / SELL', () => {
      for (const r of ['BUY', 'HOLD', 'SELL']) {
        expect(Recommendation.parse(r)).toBe(r);
      }
    });

    it('rejects unknown recommendation', () => {
      expect(() => Recommendation.parse('STRONG_BUY')).toThrow();
    });
  });

  describe('shared-types reuse', () => {
    it('AnalysisType validates real enum values', () => {
      expect(AnalysisType.parse('FUNDAMENTAL')).toBe('FUNDAMENTAL');
      expect(AnalysisType.parse('PORTFOLIO')).toBe('PORTFOLIO');
    });

    it('Signal / Confidence validate real enum values', () => {
      expect(Signal.parse('BULLISH')).toBe('BULLISH');
      expect(Confidence.parse('HIGH')).toBe('HIGH');
    });

    it('rejects values not in shared-types enums', () => {
      expect(() => AnalysisType.parse('INVALID_TYPE')).toThrow();
      expect(() => Signal.parse('STRONG_BUY')).toThrow();
    });
  });
});
