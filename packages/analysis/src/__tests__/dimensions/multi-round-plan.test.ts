import { describe, expect, it } from 'vitest';
import { ALL_DIMENSIONS } from '../../dimensions';
import { RESEARCH_PRESETS } from '../../presets';

describe('research presets', () => {
  it('keeps budgets code-owned and exposes only mode-level differences', () => {
    expect(RESEARCH_PRESETS.QUICK.maxRounds).toBe(1);
    expect(RESEARCH_PRESETS.DEEP.maxRounds).toBe(2);
    expect(RESEARCH_PRESETS.QUICK.maxFindingsPerSection).toBeLessThan(
      RESEARCH_PRESETS.DEEP.maxFindingsPerSection,
    );
  });

  it('has a second-round plan only for deeper research dimensions', () => {
    expect(ALL_DIMENSIONS.find((dimension) => dimension.type === 'COMPANY_QUALITY')?.multiRoundPlan)
      .toBeDefined();
    expect(ALL_DIMENSIONS.find((dimension) => dimension.type === 'MARKET_SIGNALS')?.multiRoundPlan)
      .toBeUndefined();
  });
});
