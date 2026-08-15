import { describe, expect, it } from 'vitest';
import { ALL_DIMENSIONS } from '../../dimensions';
import { RESEARCH_PRESETS } from '../../presets';

describe('research presets', () => {
  it('keeps budgets code-owned and exposes only mode-level differences', () => {
    expect(RESEARCH_PRESETS.QUICK.maxToolCallsPerSection).toBeLessThan(
      RESEARCH_PRESETS.DEEP.maxToolCallsPerSection,
    );
    expect(RESEARCH_PRESETS.QUICK.maxOutputTokens).toBeLessThan(
      RESEARCH_PRESETS.DEEP.maxOutputTokens,
    );
    expect(RESEARCH_PRESETS.QUICK.maxStructuredTokens).toBeLessThan(
      RESEARCH_PRESETS.DEEP.maxStructuredTokens,
    );
  });

  it('has a second-round plan only for deeper research dimensions', () => {
    expect(ALL_DIMENSIONS.find((dimension) => dimension.type === 'COMPANY_QUALITY')?.multiRoundPlan)
      .toBeDefined();
    expect(ALL_DIMENSIONS.find((dimension) => dimension.type === 'MARKET_SIGNALS')?.multiRoundPlan)
      .toBeUndefined();
  });
});
