import { z } from 'zod';
import { AnalysisResult } from './analysis-result';
import { Citation } from './citation';
import { RunStatus, SectionType } from './enums';
import { EvidencePack } from './evidence-pack';
import { EvidencePackV2 } from './evidence-pack-v2';
import { JudgeResult } from './judge-result';

// All SSE events carry runId + monotonic seq, enabling resume(runId, afterSeq).
// MVP doc §1.1 defines payload + replay semantics for each.
const baseEvent = z.object({
  runId: z.string().min(1),
  seq: z.number().int().nonnegative(),
});

export const SectionStartEvent = baseEvent.extend({
  type: z.literal('section_start'),
  sectionType: SectionType,
  order: z.number().int().nonnegative(),
});

export const ReportChunkEvent = baseEvent.extend({
  type: z.literal('report_chunk'),
  sectionType: SectionType,
  deltaText: z.string(),
});

export const ReportCompleteEvent = baseEvent.extend({
  type: z.literal('report_complete'),
  sectionType: SectionType,
  fullMarkdown: z.string(),
});

export const StructuredDataEvent = baseEvent.extend({
  type: z.literal('structured_data'),
  sectionType: SectionType,
  // Strongly typed at the dimension layer; here we only know it's JSON.
  json: z.unknown(),
});

export const CitationEvent = baseEvent.extend({
  type: z.literal('citation'),
  sectionType: SectionType,
  citation: Citation,
});

export const SectionCompleteEvent = baseEvent.extend({
  type: z.literal('section_complete'),
  sectionType: SectionType,
  status: RunStatus,
  // Optional per-section usage, populated by streamDimension so callers can
  // accumulate run-wide totals without subscribing to every cost_update.
  usage: z
    .object({
      tokensIn: z.number().int().nonnegative(),
      tokensOut: z.number().int().nonnegative(),
      llmCalls: z.number().int().nonnegative().optional(),
      toolCalls: z.number().int().nonnegative().optional(),
      durationMs: z.number().nonnegative().optional(),
      citationsCount: z.number().int().nonnegative().optional(),
      costUsd: z.number().nonnegative().optional(),
      // RFC-01: prompt cache telemetry. Non-zero starting Phase 3.
      cacheReadInputTokens: z.number().int().nonnegative().optional(),
      cacheCreationInputTokens: z.number().int().nonnegative().optional(),
      // RFC-01: provider-internal web_search telemetry.
      webSearchRequests: z.number().int().nonnegative().optional(),
      webSearchErrorsCount: z.number().int().nonnegative().optional(),
    })
    .optional(),
});

/**
 * RFC rfc-evidence-pack-web-search-fallback §2.4: emitted when a
 * dimension is intentionally skipped because the active EvidencePack is
 * degraded AND the dim's `requiresPrivateData` intersects the pack's
 * `missingPrivateFields`. Distinct from `section_complete{status:FAILED}`
 * — this is a controlled skip, not a runtime error.
 */
export const SectionSkippedEvent = baseEvent.extend({
  type: z.literal('section_skipped'),
  sectionType: SectionType,
  reason: z.literal('DEGRADED_SOURCE_MISSING_PRIVATE_DATA'),
  /** Which private fields are missing (subset of dim.requiresPrivateData). */
  missingFields: z.array(
    z.enum(['northboundFlow', 'lhb', 'unlockCalendar', 'consensusEps']),
  ),
});

export const SummaryChunkEvent = baseEvent.extend({
  type: z.literal('summary_chunk'),
  deltaText: z.string(),
});

export const SummaryCompleteEvent = baseEvent.extend({
  type: z.literal('summary_complete'),
  fullMarkdown: z.string(),
  json: z.unknown(),
});

export const CostUpdateEvent = baseEvent.extend({
  type: z.literal('cost_update'),
  totalUsd: z.number().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  toolCalls: z.number().int().nonnegative(),
  // RFC-01: optional run-wide cache + web_search aggregates. All new fields
  // are optional so existing UI consumers (apps/web SSE hooks) keep working.
  cacheReadTokens: z.number().int().nonnegative().optional(),
  cacheCreationTokens: z.number().int().nonnegative().optional(),
  webSearchRequests: z.number().int().nonnegative().optional(),
});

// RFC-01: separate event so UI can surface web_search degradation without
// reading deep into usage diffs. Emitted once per error occurrence; counts
// also accumulate into SectionCompleteEvent.usage.webSearchErrorsCount.
export const WebSearchWarningEvent = baseEvent.extend({
  type: z.literal('web_search_warning'),
  sectionType: SectionType.optional(),
  code: z.enum([
    'too_many_requests',
    'invalid_input',
    'max_uses_exceeded',
    'query_too_long',
    'unavailable',
  ]),
  occurredAt: z.string().datetime(),
  /** Multi-round path: which round (1-indexed) the error happened in. */
  round: z.number().int().positive().optional(),
});

export const DoneEvent = baseEvent.extend({
  type: z.literal('done'),
  status: RunStatus,
  /**
   * Always present (MVP doc §1.1). For workflows that terminated before
   * structured output (FAILED / CANCELLED / BUDGET_EXHAUSTED),
   * `result.structuredJson` is null but the rest of the shape is intact.
   */
  result: AnalysisResult,
});

export const ErrorEvent = baseEvent.extend({
  type: z.literal('error'),
  sectionType: SectionType.optional(),
  message: z.string().min(1),
  recoverable: z.boolean(),
});

// plan-v2 Wave 3.3 — debate workflow events (debate_round_start /
// debate_chunk / debate_round_complete / judge_chunk / debate_complete)
// + EvidenceSourceDegradedEvent + CrossDimWarningEvent removed. DEBATE
// workflow is gone; web_search v1 fallback / cross-dim downgrades still
// run internally but no longer emit dedicated SSE frames.

/**
 * v0.6 PRD §11.1 — `evidence_pack_ready` carries either a v2 or v1 pack
 * (discriminated on `pack.schemaVersion`). v1 packs lack the field entirely;
 * v2 packs carry `schemaVersion: 'evidence-pack-v2'`. Planner-driven analysis
 * additionally emits `planId / snapshotId / originCounts` for observability.
 *
 * Wire compat:
 *   - existing v1 debate/legacy consumers see no shape change (extra optional
 *     fields are ignored under z.object passthrough);
 *   - new v0.6 consumers route on `pack.schemaVersion` to decode v2 facts.
 *
 * zod's `discriminatedUnion` requires a literal discriminator on every member.
 * v1 EvidencePack has no `schemaVersion`, so we use `z.union` (v2 first, v1
 * fallback). The catchall is exercised in
 * `__tests__/evidence-pack-ready-discriminator.test.ts`.
 */
export const EvidencePackReadyEvent = baseEvent.extend({
  type: z.literal('evidence_pack_ready'),
  pack: z.union([EvidencePackV2, EvidencePack]),
  planId: z.string().optional(),
  snapshotId: z.string().optional(),
  originCounts: z
    .object({
      fromSnapshot: z.number().int().nonnegative(),
      providerNative: z.number().int().nonnegative(),
    })
    .optional(),
});

/**
 * RFC-10 §8.1: emitted by streamComprehensive's selective-judge phase.
 *
 * Flow per dim that `shouldJudge` selects:
 *   judge_start { sectionType } → runJudge() → judge_complete { sectionType, result, trace* }
 *
 * Frontends that don't care can ignore both events (no contract break).
 * apps/api adapter folds `result` into `Section.structuredJson.judgeResult`
 * for replay and surfaces concerns in UI. Comprehensive judge uses
 * `provider.complete` and emits one start+complete pair per audited dim.
 */
export const JudgeStartEvent = baseEvent.extend({
  type: z.literal('judge_start'),
  sectionType: SectionType,
});

export const JudgeCompleteEvent = baseEvent.extend({
  type: z.literal('judge_complete'),
  sectionType: SectionType,
  result: JudgeResult,
  /** Token + USD breakdown for telemetry attribution. */
  traceTokensIn: z.number().int().nonnegative(),
  traceTokensOut: z.number().int().nonnegative(),
  traceCostUsd: z.number().nonnegative(),
  traceDurationMs: z.number().nonnegative(),
});

export const SseEvent = z.discriminatedUnion('type', [
  SectionStartEvent,
  ReportChunkEvent,
  ReportCompleteEvent,
  StructuredDataEvent,
  CitationEvent,
  SectionCompleteEvent,
  SectionSkippedEvent,
  SummaryChunkEvent,
  SummaryCompleteEvent,
  CostUpdateEvent,
  DoneEvent,
  ErrorEvent,
  EvidencePackReadyEvent,
  WebSearchWarningEvent,
  JudgeStartEvent,
  JudgeCompleteEvent,
]);
export type SseEvent = z.infer<typeof SseEvent>;
