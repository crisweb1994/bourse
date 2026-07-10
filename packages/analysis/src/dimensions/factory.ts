import { z } from 'zod';
import { StructuredJson } from '../contracts/analysis-result';
import type { SectionType } from '../contracts/enums';
import { InvalidContractError } from '../primitives/errors';
import { DEFAULT_FRESHNESS } from './freshness';
import { defaultScore } from './score';
import type { Dimension, DimensionInput, MultiRoundPlan } from './types';

/**
 * Shared input schema for all walking-skeleton dimensions. Wave 5 may
 * specialize per-dimension (e.g., PORTFOLIO + investorProfile).
 */
export const STANDARD_INPUT_SCHEMA = z.object({
  symbol: z.string().min(1),
  market: z.string().min(1),
  name: z.string().optional(),
  locale: z.string().min(2),
});

export interface StandardDimensionConfig {
  type: SectionType;
  systemPrompt: string;
  userPromptTemplate: (input: DimensionInput) => string;
  /**
   * Plan 3 §4.3.5: optional multi-round plan. When set, the dim runner
   * builds rounds[] from `multiRoundPlan.roundPrompts` and passes them
   * to provider.stream(). Round 1's user prompt is `userPromptTemplate`.
   */
  multiRoundPlan?: MultiRoundPlan;
  /**
   * RFC rfc-evidence-pack-web-search-fallback §2.4: forwarded to
   * `Dimension.requiresPrivateData`. When the active EvidencePack is
   * degraded AND `pack.missingPrivateFields` overlaps this list, the
   * dim is skipped.
   */
  requiresPrivateData?: ReadonlyArray<
    'northboundFlow' | 'lhb' | 'unlockCalendar' | 'consensusEps'
  >;
}

/**
 * Build a Dimension that uses every walking-skeleton default
 * (StructuredJson schema, DEFAULT_FRESHNESS, defaultScore lookup,
 * webSearch as the only allowed tool, retry-once on failure).
 */
export function makeStandardDimension(
  config: StandardDimensionConfig,
): Dimension {
  // MVP doc §3.1: multiRoundPlan.roundPrompts.length must equal maxRounds - 1.
  // (Round 1's user prompt comes from buildPrompts; follow-up rounds from
  // roundPrompts.) LLM never decides round count — code-side hard check.
  // refactor-v1 Wave 5: validation moved here from removed registerDimension.
  if (config.multiRoundPlan) {
    const { maxRounds, roundPrompts } = config.multiRoundPlan;
    const expectedLen = maxRounds - 1;
    if (roundPrompts.length !== expectedLen) {
      throw new InvalidContractError(
        `Dimension ${config.type} multiRoundPlan: roundPrompts.length=${roundPrompts.length} but maxRounds=${maxRounds} requires exactly ${expectedLen} follow-up prompt(s)`,
      );
    }
  }
  return {
    type: config.type,
    inputSchema: STANDARD_INPUT_SCHEMA,
    buildPrompts(input) {
      return {
        system: config.systemPrompt,
        user: config.userPromptTemplate(input),
      };
    },
    allowedTools: ['webSearch'] as const,
    outputSchema: StructuredJson,
    freshness: DEFAULT_FRESHNESS,
    score(result) {
      return defaultScore(
        result.conclusion.signal,
        result.conclusion.confidence,
      );
    },
    onFailure: 'retry-once',
    ...(config.multiRoundPlan
      ? { multiRoundPlan: config.multiRoundPlan }
      : {}),
    ...(config.requiresPrivateData
      ? { requiresPrivateData: config.requiresPrivateData }
      : {}),
  };
}

/** Display name fallback used by per-dimension userPromptTemplates. */
export function displayName(input: DimensionInput): string {
  return input.name ?? input.symbol;
}
