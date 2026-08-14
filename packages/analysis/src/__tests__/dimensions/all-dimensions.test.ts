import { describe, expect, it } from 'vitest';
import { ALL_DIMENSIONS } from '../../dimensions';

const TYPES = [
    'COMPANY_QUALITY',
    'INDUSTRY_POSITION',
    'VALUATION_SCENARIOS',
    'RISK_REGISTER',
    'MARKET_SIGNALS',
] as const;

describe('Analysis V2 dimensions', () => {
  it('exports exactly five dimensions in the stable workflow order', () => {
    expect(ALL_DIMENSIONS.map((dimension) => dimension.type)).toEqual(TYPES);
  });

  it('gives every dimension the same safe output contract', () => {
    for (const dimension of ALL_DIMENSIONS) {
      expect(dimension.onFailure).toBe('skip');
      expect(dimension.allowedTools).toEqual(['webSearch']);
      expect(dimension.outputSchema).toBeDefined();
      expect(dimension.buildPrompts({ symbol: 'AAPL', market: 'US', locale: 'zh-CN' }, { todayDate: '2026-01-15' }).user)
        .toContain('AAPL');
    }
  });

  it('keeps risk in the second wave and valuation private-data gating explicit', () => {
    expect(ALL_DIMENSIONS.find((dimension) => dimension.type === 'RISK_REGISTER')?.wave).toBe(2);
    expect(ALL_DIMENSIONS.find((dimension) => dimension.type === 'VALUATION_SCENARIOS')?.requiresPrivateData)
      .toEqual(['consensusEps']);
  });
});
