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

  it('throws InvalidContractError for unknown type', () => {
    expect(() =>
      getDimension('UNKNOWN_TYPE' as never),
    ).toThrowError(InvalidContractError);
  });
});
