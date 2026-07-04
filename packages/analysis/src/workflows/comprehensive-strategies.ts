/**
 * Execution-strategy helpers for `streamComprehensive`.
 *
 * Wave (RFC-05) and legacy parallel modes share the same per-dim harvest +
 * drain + accumulate contract — previously inlined twice in
 * `comprehensive.ts` (~150 lines of near-verbatim duplication). This file
 * holds the shared core:
 *
 *  - `harvestDimBuffered`: run one dim's streamDimension with retry-once,
 *    buffer its SSE events, return the accumulator + events + last error.
 *  - `applyHarvest`: drain a harvest's buffered events (renumbering seq),
 *    finalize the dim, fold usage into the running totals, and yield the
 *    per-dim `cost_update` (and any dim error event). Returns the updated
 *    running totals so the caller can keep its local accumulators in sync
 *    (the caller still owns the variables; this helper never mutates them
 *    directly — it returns the delta-folded result).
 */
import type { Citation } from '../contracts/citation';
import type { AnalysisType } from '../contracts/enums';
import type { EvidencePackAny } from '../contracts/evidence-pack';
import type { SseEvent } from '../contracts/sse-events';
import type { Dimension, DimensionRunResult } from '../dimensions/types';
import type { DomainTier } from '../markets/types';
import type { AgentProvider } from '../primitives/provider';
import { streamDimension } from '../primitives/stream-dimension';
import type { ToolMiddlewareRunner } from '../tools/middleware';
import {
  accumulate,
  finalizeDim,
  makePerDimTraceEntry,
  type DimAccumulator,
} from './comprehensive-helpers';
import type { DimensionFailure, DimensionInput } from './types';

/** Result of harvesting a single dim's stream (buffered for later drain). */
export interface DimHarvestResult {
  dim: Dimension;
  events: SseEvent[];
  acc: DimAccumulator;
  error: Error | null;
}

/** Immutable inputs shared across every per-dim harvest in one run. */
export interface HarvestContext {
  provider: AgentProvider;
  input: DimensionInput;
  runId: string;
  todayDate: string;
  signal: AbortSignal | undefined;
  evidencePack: EvidencePackAny | undefined;
  marketAllowedDomains: string[] | undefined;
  marketDomainTiers: Record<string, DomainTier> | undefined;
}

/** Running totals folded across all harvested dims in a run. */
export interface HarvestTotals {
  tokensIn: number;
  tokensOut: number;
  llmCalls: number;
  toolCalls: number;
  costUsd: number;
}

/** Mutable collections the caller owns; passed by reference. */
export interface HarvestCollections {
  dimResults: Map<AnalysisType, DimensionRunResult>;
  failures: DimensionFailure[];
  allCitations: Citation[];
  allWarnings: string[];
  perDimTrace: Map<
    AnalysisType,
    {
      durationMs: number;
      citationsCount: number;
      tokensIn: number;
      tokensOut: number;
      llmCalls: number;
      toolCalls: number;
    }
  >;
  toolMiddleware: ToolMiddlewareRunner;
}

/**
 * Run one dim's `streamDimension` with retry-once, buffering its SSE events.
 * On retry, the accumulator is reset (only the successful attempt's events
 * are kept). Returns the final accumulator + buffered events + last error
 * (null when the dim succeeded within `maxAttempts`).
 *
 * Buffering is required because wave/parallel modes must renumber event seq
 * globally during drain — the events can't be yielded inline.
 */
export async function harvestDimBuffered(
  ctx: HarvestContext,
  dim: Dimension,
  i: number,
): Promise<DimHarvestResult> {
  const acc: DimAccumulator = {
    markdown: '',
    json: null,
    citations: [],
    usage: { tokensIn: 0, tokensOut: 0 },
    llmCalls: 0,
    toolCalls: 0,
    durationMs: 0,
    citationsCount: 0,
    costUsd: 0,
  };
  const events: SseEvent[] = [];
  let lastError: Error | null = null;
  const maxAttempts = dim.onFailure === 'retry-once' ? 2 : 1;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const subGen = streamDimension(ctx.provider, dim, ctx.input, {
        runId: ctx.runId,
        startSeq: 0, // global re-numbering happens during drain
        order: i,
        todayDate: ctx.todayDate,
        signal: ctx.signal,
        ...(ctx.evidencePack ? { evidencePack: ctx.evidencePack } : {}),
        ...(ctx.marketAllowedDomains && ctx.marketAllowedDomains.length > 0
          ? { allowedDomains: ctx.marketAllowedDomains }
          : {}),
        ...(ctx.marketDomainTiers
          ? { domainTiers: ctx.marketDomainTiers }
          : {}),
      });
      Object.assign(acc, {
        markdown: '',
        json: null,
        citations: [],
        usage: { tokensIn: 0, tokensOut: 0 },
        llmCalls: 0,
        toolCalls: 0,
        durationMs: 0,
        citationsCount: 0,
        costUsd: 0,
      });
      const attemptEvents: SseEvent[] = [];
      for await (const event of subGen) {
        attemptEvents.push(event);
        accumulate(event, acc);
      }
      events.splice(0, events.length, ...attemptEvents);
      lastError = null;
      break;
    } catch (e) {
      lastError = e as Error;
    }
  }
  return { dim, events, acc, error: lastError };
}

/**
 * Drain one harvest: re-yield its buffered events with globally increasing
 * seq, finalize the dim, fold its usage/citations/warnings/trace into the
 * shared collections + running totals, and yield the per-dim `cost_update`.
 *
 * On harvest error (retry-once exhausted), the dim is recorded as a failure
 * + an `error` SSE is yielded, and the dim is NOT finalized. On `finalizeDim`
 * throw (malformed structuredJson after repair), the dim is recorded as a
 * failure instead of crashing the whole run.
 *
 * `totals` is the running snapshot at drain start; the RETURNED value is the
 * updated snapshot (caller reassigns). This keeps the caller's local
 * accumulators the single source of truth — the helper never reaches back
 * into the caller's scope.
 *
 * `nextSeq()` returns the next seq value and advances the caller's counter —
 * kept as a callback so this helper stays agnostic to how seq is stored.
 */
export async function* applyHarvest(
  h: DimHarvestResult,
  collections: HarvestCollections,
  totals: HarvestTotals,
  runId: string,
  nextSeq: () => number,
): AsyncGenerator<SseEvent, HarvestTotals, undefined> {
  // Drain buffered events with global seq renumbering.
  for (const event of h.events) {
    yield { ...event, seq: nextSeq() };
  }

  // Retry-once exhausted → record failure + emit dim error, skip finalize.
  if (h.error) {
    collections.failures.push({
      type: h.dim.type,
      error: h.error.message,
    });
    yield {
      type: 'error',
      runId,
      seq: nextSeq(),
      sectionType: h.dim.type,
      message: h.error.message,
      recoverable: false,
    };
    return totals;
  }

  try {
    const result = finalizeDim(h.dim, h.acc);
    collections.dimResults.set(h.dim.type, result);
    totals.tokensIn += h.acc.usage.tokensIn;
    totals.tokensOut += h.acc.usage.tokensOut;
    totals.llmCalls += h.acc.llmCalls;
    totals.toolCalls += h.acc.toolCalls;
    totals.costUsd += h.acc.costUsd;
    collections.perDimTrace.set(h.dim.type, makePerDimTraceEntry(h.acc));
    collections.allCitations.push(...h.acc.citations);
    collections.allWarnings.push(...result.warnings);
    if (h.acc.toolCalls > 0) {
      // Day 11.5b: route per-dim tool invocations through middleware.
      for (let n = 0; n < h.acc.toolCalls; n++) {
        collections.toolMiddleware.record({
          toolName: 'webSearch',
          startedAt: Date.now(),
          durationMs: 0,
          citationsCount: 0,
          tokensIn: Math.floor(h.acc.usage.tokensIn / h.acc.toolCalls),
          tokensOut: Math.floor(h.acc.usage.tokensOut / h.acc.toolCalls),
        });
      }
    }
    yield {
      type: 'cost_update',
      runId,
      seq: nextSeq(),
      totalUsd: totals.costUsd,
      totalTokens: totals.tokensIn + totals.tokensOut,
      toolCalls: totals.toolCalls,
    };
  } catch (e) {
    collections.failures.push({
      type: h.dim.type,
      error: (e as Error).message,
    });
  }
  return totals;
}
