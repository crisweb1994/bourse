import { describe, expect, it } from 'vitest';
import { getDimension } from '../../dimensions';

describe('dimension routing V2', () => {
  it('routes each public section type to a matching dimension', () => {
    for (const type of [
      'COMPANY_QUALITY', 'INDUSTRY_POSITION', 'VALUATION_SCENARIOS',
      'RISK_REGISTER', 'MARKET_SIGNALS',
    ] as const) {
      expect(getDimension(type).type).toBe(type);
    }
  });
});
