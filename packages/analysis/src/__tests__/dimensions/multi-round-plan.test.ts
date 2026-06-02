/**
 * MultiRoundPlan validation — refactor-v1 Wave 5：
 * 校验从 `registerDimension` 移到 `makeStandardDimension`，模块加载时即 throw。
 * 测试改为直接调 factory。
 */
import { describe, expect, it } from 'vitest';
import { makeStandardDimension } from '../../dimensions/factory';
import { InvalidContractError } from '../../primitives/errors';

const base = {
  type: 'FUNDAMENTAL' as const,
  systemPrompt: 's',
  userPromptTemplate: () => 'u',
};

describe('makeStandardDimension — multiRoundPlan validation', () => {
  it('accepts maxRounds:2 with exactly 1 followup prompt', () => {
    expect(() =>
      makeStandardDimension({
        ...base,
        multiRoundPlan: { maxRounds: 2, roundPrompts: [() => 'r2'] },
      }),
    ).not.toThrow();
  });

  it('accepts maxRounds:3 with exactly 2 followup prompts', () => {
    expect(() =>
      makeStandardDimension({
        ...base,
        multiRoundPlan: { maxRounds: 3, roundPrompts: [() => 'r2', () => 'r3'] },
      }),
    ).not.toThrow();
  });

  it('rejects maxRounds:2 with 0 followup prompts', () => {
    expect(() =>
      makeStandardDimension({
        ...base,
        multiRoundPlan: { maxRounds: 2, roundPrompts: [] },
      }),
    ).toThrowError(InvalidContractError);
  });

  it('rejects maxRounds:3 with only 1 followup prompt', () => {
    expect(() =>
      makeStandardDimension({
        ...base,
        multiRoundPlan: { maxRounds: 3, roundPrompts: [() => 'r2'] },
      }),
    ).toThrowError(InvalidContractError);
  });

  it('rejects maxRounds:2 with 2 followup prompts (over-specified)', () => {
    expect(() =>
      makeStandardDimension({
        ...base,
        multiRoundPlan: { maxRounds: 2, roundPrompts: [() => 'r2', () => 'extra'] },
      }),
    ).toThrowError(InvalidContractError);
  });

  it('accepts dim without multiRoundPlan (single-round)', () => {
    expect(() => makeStandardDimension(base)).not.toThrow();
  });
});
