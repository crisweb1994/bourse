/**
 * Dimension lookup by SectionType.
 *
 * refactor-v1 Wave 5：原 mutable Map 注册机制（registerDimension + clearRegistry）
 * 已删。DIMENSION_CONFIGS 现在是唯一真源，ALL_DIMENSIONS 由 factory 派生，
 * 本文件只剩纯查询。
 */
import type { SectionType } from '../contracts/enums';
import { InvalidContractError } from '../primitives/errors';
import { ALL_DIMENSIONS } from './configs';
import type { Dimension } from './types';

const BY_TYPE: ReadonlyMap<SectionType, Dimension> = new Map(
  ALL_DIMENSIONS.map((d) => [d.type, d] as const),
);

/**
 * Get the dimension for a given SectionType. Throws when no dim is
 * registered for the type (should be unreachable: SectionType enum +
 * DIMENSION_CONFIGS array are kept in sync).
 */
export function getDimension(type: SectionType): Dimension {
  const dim = BY_TYPE.get(type);
  if (!dim) {
    throw new InvalidContractError(`No dimension registered for type: ${type}`);
  }
  return dim;
}

/** All SectionType values that have a registered dimension. */
export function listDimensions(): SectionType[] {
  return Array.from(BY_TYPE.keys());
}
