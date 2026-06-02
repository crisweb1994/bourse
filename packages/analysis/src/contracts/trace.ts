import { z } from 'zod';
import { AnalysisType } from './enums';

export const PerDimensionTrace = z.object({
  durationMs: z.number().nonnegative(),
  citationsCount: z.number().int().nonnegative(),
  tokensIn: z.number().int().nonnegative(),
  tokensOut: z.number().int().nonnegative(),
  /** Number of LLM round-trips (stream + complete + any repair pass). */
  llmCalls: z.number().int().nonnegative().optional(),
  /** Number of provider-internal tool invocations (e.g. webSearch). */
  toolCalls: z.number().int().nonnegative().optional(),
  // RFC-01: prompt cache telemetry. Non-zero starting Phase 3.
  cacheReadInputTokens: z.number().int().nonnegative().optional(),
  cacheCreationInputTokens: z.number().int().nonnegative().optional(),
  // RFC-01: provider-internal web_search telemetry.
  webSearchRequests: z.number().int().nonnegative().optional(),
  webSearchErrorsCount: z.number().int().nonnegative().optional(),
  // RFC-01: USD cost computed from pricing.ts. Already surfaced via
  // SectionCompleteEvent.usage.costUsd, mirrored here for trace aggregation.
  costUsd: z.number().nonnegative().optional(),
});
export type PerDimensionTrace = z.infer<typeof PerDimensionTrace>;

// Top-level run-wide trace. Populated by primitives/trace.ts at runtime.
// `perDimension` is keyed by AnalysisType but stored as a plain record so
// failed dimensions just don't appear (no need to seed defaults).
export const Trace = z.object({
  llmCalls: z.number().int().nonnegative(),
  toolCalls: z.number().int().nonnegative(),
  tokensIn: z.number().int().nonnegative(),
  tokensOut: z.number().int().nonnegative(),
  totalUsd: z.number().nonnegative(),
  durationMs: z.number().nonnegative(),
  perDimension: z.record(AnalysisType, PerDimensionTrace).optional(),
  // RFC-01: run-wide aggregates. Optional for backwards compatibility with
  // older traces; sum of perDimension values when present.
  cacheReadInputTokens: z.number().int().nonnegative().optional(),
  cacheCreationInputTokens: z.number().int().nonnegative().optional(),
  webSearchRequests: z.number().int().nonnegative().optional(),
  webSearchErrorsCount: z.number().int().nonnegative().optional(),
});
export type Trace = z.infer<typeof Trace>;
