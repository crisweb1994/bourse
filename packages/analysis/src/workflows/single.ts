import type { AnalysisResult } from '../contracts/analysis-result';
import type { Citation } from '../contracts/citation';
import type { RunStatus } from '../contracts/enums';
import type { EvidencePackAny } from '../contracts/evidence-pack';
import type { SseEvent } from '../contracts/sse-events';
import type { Dimension, DimensionInput } from '../dimensions/types';
import type { DomainTier } from '../markets/types';
import { computeUsd } from '../primitives/pricing';
import type { AgentProvider } from '../primitives/provider';
import { streamDimension } from '../primitives/stream-dimension';
import { ToolMiddlewareRunner } from '../tools/middleware';
import { checkBudget } from './comprehensive-helpers';
import type { BudgetLimits } from './types';

export interface SingleOptions {
  runId: string;
  startSeq?: number;
  todayDate?: string;
  signal?: AbortSignal;
  /**
   * Path A: pre-built evidence pack (connector → compute → snapshotToEvidencePack
   * + CN signals). When present it's prepended to the dim prompt, so single-dim
   * analyses get the same structured facts + computed ratios as comprehensive
   * (not LLM-only). Optional so tests can omit it.
   */
  evidencePack?: EvidencePackAny;
  /** RFC-06: web_search host allowlist (derived from market profile domainTiers). */
  allowedDomains?: readonly string[];
  /** RFC-06: code-side domain→tier table forwarded to the evidence gate. */
  domainTiers?: Record<string, DomainTier>;
  /**
   * Per-run cost limits. For a single dimension, the check is post-hoc
   * (after the section completes): if the section overshot any cap, the
   * returned AnalysisResult.status is `BUDGET_EXHAUSTED` and the data
   * is still surfaced. Mid-stream prevention is a Day 11+ enhancement.
   */
  budget?: BudgetLimits;
}

interface DimAccumulator {
  markdown: string;
  json: unknown;
  citations: Citation[];
  signal: 'BULLISH' | 'NEUTRAL' | 'BEARISH';
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  usage: { tokensIn: number; tokensOut: number };
  llmCalls: number;
  toolCalls: number;
  durationMs: number;
  costUsd: number;
}

/**
 * Single-dimension workflow: streamDimension + done event with the
 * dimension's StructuredJson packaged as AnalysisResult. The natural
 * counterpart to streamComprehensive when callers only need one
 * analysis section.
 */
export async function* streamSingle(
  provider: AgentProvider,
  dimension: Dimension,
  input: DimensionInput,
  options: SingleOptions,
): AsyncGenerator<SseEvent, AnalysisResult, undefined> {
  let seq = options.startSeq ?? 0;
  const startedAt = Date.now();
  // Day 11.5b: route tool invocations through middleware (CLAUDE.md
  // §3 #16). For single workflow the runner mostly serves as a
  // hook for future cost / cap / domain rules.
  const toolMiddleware = new ToolMiddlewareRunner({});
  const acc: DimAccumulator = {
    markdown: '',
    json: null,
    citations: [],
    signal: 'NEUTRAL',
    confidence: 'LOW',
    usage: { tokensIn: 0, tokensOut: 0 },
    llmCalls: 0,
    toolCalls: 0,
    durationMs: 0,
    costUsd: 0,
  };
  let dimError: Error | null = null;

  // Path A: surface the pre-built pack so the frontend can read degradedSource,
  // mirroring streamComprehensive. No-op when no pack was supplied (tests).
  if (options.evidencePack) {
    yield {
      type: 'evidence_pack_ready',
      runId: options.runId,
      seq: seq++,
      pack: options.evidencePack as never,
    };
  }

  try {
    for await (const event of streamDimension(provider, dimension, input, {
      runId: options.runId,
      startSeq: seq,
      order: 0,
      todayDate: options.todayDate,
      signal: options.signal,
      ...(options.evidencePack ? { evidencePack: options.evidencePack } : {}),
      ...(options.allowedDomains && options.allowedDomains.length > 0
        ? { allowedDomains: options.allowedDomains }
        : {}),
      ...(options.domainTiers ? { domainTiers: options.domainTiers } : {}),
    })) {
      seq = event.seq + 1;
      yield event;
      switch (event.type) {
        case 'report_complete':
          acc.markdown = event.fullMarkdown;
          break;
        case 'structured_data':
          acc.json = event.json;
          break;
        case 'citation':
          acc.citations.push(event.citation);
          break;
        case 'section_complete':
          if (event.usage) {
            acc.usage = {
              tokensIn: event.usage.tokensIn,
              tokensOut: event.usage.tokensOut,
            };
            acc.llmCalls = event.usage.llmCalls ?? 0;
            acc.toolCalls = event.usage.toolCalls ?? 0;
            acc.durationMs = event.usage.durationMs ?? 0;
            acc.costUsd = event.usage.costUsd ?? 0;
          }
          break;
      }
    }
  } catch (e) {
    dimError = e as Error;
    yield {
      type: 'error',
      runId: options.runId,
      seq: seq++,
      sectionType: dimension.type,
      message: dimError.message,
      recoverable: false,
    };
  }

  // Day 11.5b: record tool uses (walking-skeleton: only webSearch).
  if (acc.toolCalls > 0) {
    for (let n = 0; n < acc.toolCalls; n++) {
      toolMiddleware.record({
        toolName: 'webSearch',
        startedAt: Date.now(),
        durationMs: 0,
        citationsCount: 0,
        tokensIn: Math.floor(acc.usage.tokensIn / acc.toolCalls),
        tokensOut: Math.floor(acc.usage.tokensOut / acc.toolCalls),
      });
    }
  }

  let parsed: ReturnType<typeof dimension.outputSchema.safeParse> | undefined;
  if (acc.json !== null) {
    parsed = dimension.outputSchema.safeParse(acc.json);
    if (parsed.success) {
      acc.signal = parsed.data.conclusion.signal;
      acc.confidence = parsed.data.conclusion.confidence;
    }
  }

  const computedCostUsd =
    acc.costUsd > 0
      ? acc.costUsd
      : computeUsd(undefined, acc.usage.tokensIn, acc.usage.tokensOut);

  // Post-hoc budget check (CLAUDE.md §3 #16 — single dim: section already
  // ran, so we report overshoot rather than prevent it). inclusive=false
  // preserves the strict `>` semantics: overshoot, not reach.
  const breach = checkBudget(
    options.budget,
    {
      tokens: acc.usage.tokensIn + acc.usage.tokensOut,
      costUsd: computedCostUsd,
      toolCalls: acc.toolCalls,
    },
    false,
  );

  const status: RunStatus = dimError
    ? 'FAILED'
    : breach
      ? 'BUDGET_EXHAUSTED'
      : 'COMPLETED';

  // Final cost_update with cumulative totals (cost_update events are now
  // emitted by the workflow layer, not streamDimension).
  yield {
    type: 'cost_update',
    runId: options.runId,
    seq: seq++,
    totalUsd: computedCostUsd,
    totalTokens: acc.usage.tokensIn + acc.usage.tokensOut,
    toolCalls: acc.toolCalls,
  };

  const result: AnalysisResult = {
    reportMarkdown: acc.markdown,
    structuredJson: parsed?.success ? parsed.data : null,
    citations: acc.citations,
    status,
    signal: acc.signal,
    confidence: acc.confidence,
    trace: {
      llmCalls: acc.llmCalls,
      toolCalls: acc.toolCalls,
      tokensIn: acc.usage.tokensIn,
      tokensOut: acc.usage.tokensOut,
      totalUsd: computedCostUsd,
      durationMs: Date.now() - startedAt,
    },
    warnings: breach ? [`Budget exhausted: ${breach}`] : [],
    partialDimensions: undefined,
  };

  yield {
    type: 'done',
    runId: options.runId,
    seq: seq++,
    status,
    result,
  };
  return result;
}

/** Convenience wrapper: drains streamSingle and returns the AnalysisResult. */
export async function runSingle(
  provider: AgentProvider,
  dimension: Dimension,
  input: DimensionInput,
  options: SingleOptions,
): Promise<AnalysisResult> {
  const gen = streamSingle(provider, dimension, input, options);
  while (true) {
    const next = await gen.next();
    if (next.done) return next.value;
  }
}
