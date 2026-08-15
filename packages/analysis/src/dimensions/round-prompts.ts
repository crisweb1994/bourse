import type { DimensionInput, DimensionRunContext } from './types';

export function round2CrossVerifOnly(
  input: DimensionInput,
  _ctx: DimensionRunContext,
): string {
  return `请复核上一轮关于 ${input.name ?? input.symbol} 的关键判断：只保留有来源支持的事实，补充最重要的反证或限制，不重复全文。`;
}
