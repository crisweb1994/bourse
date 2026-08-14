import { z } from 'zod';
import { AnalysisResult } from './analysis-result';
import { Citation } from './citation';
import { AnalysisStatus, SectionStatus, SectionType } from './enums';
import { EvidencePackV2 } from './evidence-pack-v2';

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
  status: SectionStatus,
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
  reason: z.enum([
    'DEGRADED_SOURCE_MISSING_PRIVATE_DATA',
    'INSUFFICIENT_REQUIRED_FACTS',
  ]),
  /** Fields that made the section impossible to run safely. */
  missingFields: z.array(z.string()),
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
  status: AnalysisStatus,
  /** Always present, including runs that end before a summary is produced. */
  result: AnalysisResult,
});

export const ErrorEvent = baseEvent.extend({
  type: z.literal('error'),
  sectionType: SectionType.optional(),
  message: z.string().min(1),
  recoverable: z.boolean(),
});

/** Immutable V2 evidence captured before module execution. */
export const EvidencePackReadyEvent = baseEvent.extend({
  type: z.literal('evidence_pack_ready'),
  pack: EvidencePackV2,
  planId: z.string().optional(),
  snapshotId: z.string().optional(),
  originCounts: z
    .object({
      fromSnapshot: z.number().int().nonnegative(),
      providerNative: z.number().int().nonnegative(),
    })
    .optional(),
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
]);
export type SseEvent = z.infer<typeof SseEvent>;
