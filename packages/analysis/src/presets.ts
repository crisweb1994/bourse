import type { AnalysisMode } from './contracts/enums';

/** Code-owned research limits. They are deliberately not user configuration. */
export const RESEARCH_PRESETS = {
  QUICK: {
    maxRounds: 1,
    maxToolCallsPerSection: 2,
    maxFindingsPerSection: 3,
  },
  DEEP: {
    maxRounds: 2,
    maxToolCallsPerSection: 5,
    maxFindingsPerSection: 6,
  },
} as const;

export type ResearchPreset = (typeof RESEARCH_PRESETS)[AnalysisMode];

export function getResearchPreset(mode: AnalysisMode): ResearchPreset {
  return RESEARCH_PRESETS[mode];
}
