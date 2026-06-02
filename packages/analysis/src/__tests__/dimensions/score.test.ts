import { describe, expect, it } from 'vitest';
import { defaultScore } from '../../dimensions/score';

describe('dimensions/defaultScore', () => {
  it('returns 85 for BULLISH+HIGH', () => {
    expect(defaultScore('BULLISH', 'HIGH')).toBe(85);
  });

  it('returns 50 for NEUTRAL+MEDIUM', () => {
    expect(defaultScore('NEUTRAL', 'MEDIUM')).toBe(50);
  });

  it('returns 15 for BEARISH+HIGH', () => {
    expect(defaultScore('BEARISH', 'HIGH')).toBe(15);
  });

  it('is symmetric — BULLISH+conf and BEARISH+conf sum near 100', () => {
    for (const conf of ['HIGH', 'MEDIUM', 'LOW'] as const) {
      const sum = defaultScore('BULLISH', conf) + defaultScore('BEARISH', conf);
      expect(sum).toBeGreaterThanOrEqual(95);
      expect(sum).toBeLessThanOrEqual(105);
    }
  });

  it('all 9 cells return values in [0, 100]', () => {
    for (const sig of ['BULLISH', 'NEUTRAL', 'BEARISH'] as const) {
      for (const conf of ['HIGH', 'MEDIUM', 'LOW'] as const) {
        const v = defaultScore(sig, conf);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(100);
      }
    }
  });
});
