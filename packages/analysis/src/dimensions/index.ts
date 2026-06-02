/**
 * Dimensions barrel — public surface.
 *
 * refactor-v1 Wave 5：
 * - 9 dim 文件已合到 ./configs（DIMENSION_CONFIGS 数组 + ALL_DIMENSIONS 派生）
 * - registry.ts mutable 注册机制删除，改 ./configs 派生的纯查询
 * - barrel 从 `export *` 收紧为白名单 export（不再暴露 factory / freshness /
 *   score / round-prompts 等包内 helper）
 */
export { ALL_DIMENSIONS, DIMENSION_CONFIGS } from './configs';
export { getDimension, listDimensions } from './registry';
export type {
  Dimension,
  DimensionInput,
  DimensionRunResult,
  MultiRoundPlan,
} from './types';
