import type { OverallConclusion } from '../contracts/comprehensive-summary';
import type { SectionResult } from '../contracts/analysis-result';

export const DEFAULT_DISCLAIMER =
  '免责声明：本报告由 AI 生成，不构成投资建议。投资有风险，入市需谨慎。';

export function applyFixedDisclaimer<T extends SectionResult>(data: T): T {
  return { ...data, disclaimer: DEFAULT_DISCLAIMER };
}

export function applyFixedDisclaimerToSummary(
  data: OverallConclusion,
): OverallConclusion {
  return { ...data, disclaimer: DEFAULT_DISCLAIMER };
}
