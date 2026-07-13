/**
 * Dimension lookup — refactor-v1 Wave 5：
 * `registerDimension / clearRegistry` 已删，DIMENSION_CONFIGS 为静态真源。
 * 这里只测 getDimension / listDimensions 的查询行为。
 */
import { describe, expect, it } from 'vitest';
import { getDimension, listDimensions } from '../../dimensions/registry';
import { ALL_DIMENSIONS } from '../../dimensions';
import { InvalidContractError } from '../../primitives/errors';

describe('dimensions/registry', () => {
  it('lists all 9 canonical dimension types', () => {
    const types = listDimensions().sort();
    expect(types).toEqual(
      [
        'FUNDAMENTAL',
        'GOVERNANCE',
        'INDUSTRY',
        'PORTFOLIO',
        'RISK',
        'SCENARIO',
        'SENTIMENT',
        'TECHNICAL',
        'VALUATION',
      ].sort(),
    );
  });

  it('getDimension returns the same instance as ALL_DIMENSIONS', () => {
    for (const dim of ALL_DIMENSIONS) {
      expect(getDimension(dim.type)).toBe(dim);
    }
  });

  it('appends the research focus without allowing it to replace the target', () => {
    const prompts = getDimension('FUNDAMENTAL').buildPrompts(
      {
        symbol: 'AAPL',
        market: 'US',
        name: 'Apple',
        locale: 'zh-CN',
        question: '和 MSFT 相比，这次财报后的增长更可靠吗？',
      },
      { todayDate: '2026-07-13' },
    );

    expect(prompts.user).toContain('【本次研究焦点】');
    expect(prompts.user).toContain('和 MSFT 相比');
    expect(prompts.user).toContain('仅作为研究主题');
    expect(prompts.user).toContain('始终以 Apple（AAPL）为准');
    expect(prompts.user).toContain('不得替换目标标的');
  });

  it('throws InvalidContractError for unknown type', () => {
    expect(() =>
      getDimension('UNKNOWN_TYPE' as never),
    ).toThrowError(InvalidContractError);
  });
});
