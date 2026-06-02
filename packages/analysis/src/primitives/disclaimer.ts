import type { ComprehensiveSummary } from '../contracts/comprehensive-summary';
import type { StructuredJson } from '../contracts/analysis-result';

/**
 * Canonical disclaimer text. Code-injected after every structured-output
 * parse so LLM-generated disclaimers cannot diverge across providers,
 * locales, or repair attempts (CLAUDE.md §4 #21).
 *
 * Matches the apps/api COMMON_SUFFIX disclaimer line verbatim so the
 * package's output stays consistent with existing consumer expectations.
 */
export const DEFAULT_DISCLAIMER =
  '免责声明：本报告由 AI 生成，不构成投资建议。投资有风险，入市需谨慎。';

export function applyFixedDisclaimer<T extends StructuredJson>(data: T): T {
  return { ...data, disclaimer: DEFAULT_DISCLAIMER };
}

export function applyFixedDisclaimerToSummary(
  data: ComprehensiveSummary,
): ComprehensiveSummary {
  return { ...data, disclaimer: DEFAULT_DISCLAIMER };
}
