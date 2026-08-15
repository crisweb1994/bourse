/** Code-owned research limits. They are deliberately not user configuration. */
export const RESEARCH_PRESETS = {
  QUICK: {
    maxToolCallsPerSection: 1,
    maxOutputTokens: 3_500,
    maxStructuredTokens: 1_800,
    maxSummaryTokens: 1_600,
    // A provider/search call must not leave the first report in "researching"
    // forever. This is code-owned policy, not user configuration.
    timeoutMs: 120_000,
  },
  DEEP: {
    maxToolCallsPerSection: 3,
    maxOutputTokens: 12_000,
    maxStructuredTokens: 5_000,
    maxSummaryTokens: 4_000,
    timeoutMs: 300_000,
  },
} as const;
