import type { EvidencePackAny } from '../contracts/evidence-pack';
import type { SseEvent } from '../contracts/sse-events';
import { buildCommonSuffix } from '../dimensions/freshness';
import type { Dimension, DimensionInput } from '../dimensions/types';
import { enforceSymbol } from '../guardrails/symbol';
import type { DomainTier } from '../markets/types';
import {
  buildStructuredOutputPrompts,
  formatEvidencePackBlock,
} from './dimension-prompts';
import { applyFixedDisclaimer } from './disclaimer';
import { applyEvidenceGate } from './evidence-gate';
import { computeUsd } from './pricing';
import type {
  AgentProvider,
  ProviderStreamResult,
  SystemPromptInput,
} from './provider';
import { structuredOutputWithRepair } from './structured-output';

export interface StreamDimensionOptions {
  /** Required: stable run id propagated on every SseEvent. */
  runId: string;
  /** Starting seq number; events emit seq, seq+1, seq+2, ... */
  startSeq?: number;
  /** Order index within a comprehensive workflow (defaults to 0). */
  order?: number;
  /** YYYY-MM-DD; defaults to today (UTC). */
  todayDate?: string;
  signal?: AbortSignal;
  /**
   * RFC-02 §13: shared EvidencePack (v1 or v2) produced upstream by
   * Stage 0. T9 plumbs this through but does NOT yet inject it into
   * `dim.buildPrompts` — that's T10. Consumers can read the value via
   * `options.evidencePack` already if they want to short-circuit early.
   */
  evidencePack?: EvidencePackAny;
  /**
   * RFC-06: bare hostnames the provider's web_search tool is allowed to
   * reach. Caller (workflow / apps/api) derives this from the market
   * profile's `domainTiers` — typically `Object.keys(domainTiers)` since
   * the table itself only lists A|B|C|D entries (E is implicit absence).
   * Forwarded as-is to provider.stream(). Undefined/empty → unrestricted.
   */
  allowedDomains?: readonly string[];
  /**
   * RFC-06: code-side ground-truth domain → tier table forwarded to
   * `applyEvidenceGate`. When set, the gate downgrades any LLM-declared
   * `qualityTier` that exceeds the inferred code-side tier. Typically
   * `marketProfile.domainTiers` for the active market. Undefined → gate
   * skips the rule (legacy behavior).
   */
  domainTiers?: Record<string, DomainTier>;
}

/**
 * Stream a single dimension as `SseEvent`s. Event order:
 *   1. section_start
 *   2. report_chunk × N + citation × N (interleaved with stream tokens)
 *   3. report_complete (after stream finishes)
 *   4. cost_update (post-stream tokens, tool_calls placeholder)
 *   5. structured_data (after structured output computed)
 *   6. cost_update (post-structured cumulative tokens)
 *   7. section_complete (with usage payload + warnings logged in trace)
 *
 * Every event carries `runId` and a monotonic `seq`. CLAUDE.md §3 #14:
 * sequence is determined by code, not LLM.
 */
export async function* streamDimension(
  provider: AgentProvider,
  dimension: Dimension,
  input: DimensionInput,
  options: StreamDimensionOptions,
): AsyncGenerator<SseEvent, void, undefined> {
  const { runId } = options;
  let seq = options.startSeq ?? 0;
  const next = (): number => seq++;
  const sectionType = dimension.type;
  const order = options.order ?? 0;
  const startedAt = Date.now();

  const validInput = dimension.inputSchema.parse(input);

  // Symbol guardrail: normalize at the package boundary so prompts only
  // ever see canonical market codes (CLAUDE.md §3 #18). Throws
  // InvalidSymbolError before any event fires when the symbol is bogus.
  const guard = enforceSymbol(validInput.symbol, validInput.market);
  const normalizedInput = {
    ...validInput,
    symbol: guard.normalized,
    market: guard.market.code,
  };

  yield {
    type: 'section_start',
    runId,
    seq: next(),
    sectionType,
    order,
  };

  const todayDate =
    options.todayDate ?? new Date().toISOString().slice(0, 10);
  const ctx = { todayDate };
  const { system, user } = dimension.buildPrompts(normalizedInput, ctx);

  // RFC-02 §13: when caller passed an EvidencePack v2 via options
  // (Stage 0 produced it in comprehensive workflow), prepend a fact-block
  // to the dim's system prompt. v1 packs (debate workflow) are ignored —
  // they're consumed in-tree by debate's own builder, not by streamDimension.
  const evidenceBlock =
    options.evidencePack &&
    options.evidencePack.schemaVersion === 'evidence-pack-v2'
      ? `${formatEvidencePackBlock(options.evidencePack)}\n\n`
      : '';

  // RFC-04: split the system prompt into 2 blocks — the stable "dim
  // instructions + common suffix" goes into a cache_control: ephemeral
  // block (reused across multi-round + short re-runs); the symbol-specific
  // EvidencePack block stays uncached. Below Anthropic's 1024-token minimum
  // the cache hint silently fails (telemetry will show
  // cacheCreationInputTokens=0); we accept that rather than try to detect
  // token count client-side. Cross-vendor: OpenAI provider flattens this
  // back to a string anyway.
  //
  // RFC 2026-05-16: when the provider has no web_search (chat.completions
  // without a pluggable WebSearchExecutor wired), swap the freshness block
  // to a "no-tool" variant that forbids pseudo tool-call syntax. Defaults
  // to true to preserve parity for providers that don't declare capabilities.
  const webSearchAvailable =
    provider.capabilities?.webSearch?.available ?? true;
  const stablePrefix = `${system}\n${buildCommonSuffix(dimension.freshness, todayDate, webSearchAvailable)}`;
  const systemForProvider: SystemPromptInput = evidenceBlock
    ? [
        { type: 'text', text: stablePrefix, cacheControl: { type: 'ephemeral' } },
        { type: 'text', text: evidenceBlock },
      ]
    : [
        { type: 'text', text: stablePrefix, cacheControl: { type: 'ephemeral' } },
      ];

  // Bridge push (provider.stream onChunk) → pull (this generator)
  const queue: SseEvent[] = [];
  let resumeIter: (() => void) | null = null;
  const wake = (): void => {
    if (resumeIter !== null) {
      const r = resumeIter;
      resumeIter = null;
      r();
    }
  };

  // Plan 3 §4.3.5: when the dim has a multiRoundPlan, build rounds[] for
  // provider.stream(). Round 1's user prompt is already passed as the second
  // argument; rounds[] contains follow-up prompts (length = maxRounds - 1).
  const providerRounds = dimension.multiRoundPlan
    ? dimension.multiRoundPlan.roundPrompts.map((build) => ({
        userPrompt: build(normalizedInput, ctx),
        maxToolUses: dimension.multiRoundPlan?.perRoundToolUses ?? 4,
      }))
    : undefined;

  const streamPromise = provider.stream(
    systemForProvider,
    user,
    (chunk) => {
      if (chunk.type === 'text') {
        queue.push({
          type: 'report_chunk',
          runId,
          seq: next(),
          sectionType,
          deltaText: chunk.text,
        });
      } else {
        queue.push({
          type: 'citation',
          runId,
          seq: next(),
          sectionType,
          citation: chunk.citation,
        });
      }
      wake();
    },
    {
      signal: options.signal,
      ...(providerRounds && providerRounds.length > 0
        ? {
            rounds: providerRounds,
            maxToolUses: dimension.multiRoundPlan?.perRoundToolUses ?? 4,
          }
        : {}),
      ...(options.allowedDomains && options.allowedDomains.length > 0
        ? { allowedDomains: options.allowedDomains }
        : {}),
    },
  );

  let settled = false;
  let streamResult: ProviderStreamResult | null = null;
  let streamError: unknown = null;
  void streamPromise
    .then((r) => {
      streamResult = r;
    })
    .catch((e: unknown) => {
      streamError = e;
    })
    .finally(() => {
      settled = true;
      wake();
    });

  while (!settled || queue.length > 0) {
    while (queue.length > 0) {
      const evt = queue.shift();
      if (evt !== undefined) yield evt;
    }
    if (!settled) {
      await new Promise<void>((resolve) => {
        resumeIter = resolve;
      });
    }
  }

  if (streamError !== null) throw streamError;
  if (streamResult === null) {
    throw new Error('streamDimension: provider.stream resolved without result');
  }

  const finalStream: ProviderStreamResult = streamResult;

  yield {
    type: 'report_complete',
    runId,
    seq: next(),
    sectionType,
    fullMarkdown: finalStream.text,
  };

  // RFC-01: surface web_search errors that happened during stream phase as
  // dedicated SSE events so UI can render warnings adjacent to the report.
  // Counts also accumulate into SectionCompleteEvent.usage below.
  for (const err of finalStream.webSearchErrors ?? []) {
    yield {
      type: 'web_search_warning',
      runId,
      seq: next(),
      sectionType,
      code: err.code,
      occurredAt: err.occurredAt,
      ...(typeof err.round === 'number' ? { round: err.round } : {}),
    };
  }

  // cost_update events are emitted by the workflow layer (Day 11.5a) where
  // run-wide cumulative totals + pricing are known. streamDimension stays
  // focused on per-section semantics.

  const allowedUrls = finalStream.citations.map((c) => c.url);
  const jsonPrompts = buildStructuredOutputPrompts(
    sectionType,
    finalStream.text,
    allowedUrls,
  );
  const structured = await structuredOutputWithRepair(
    provider,
    jsonPrompts.system,
    jsonPrompts.user,
    dimension.outputSchema,
    { signal: options.signal },
  );

  // Plan 3 §4.3.4: A-E quality gate (E-only removal + AB-ratio checks).
  // RFC-06: pass `domainTiers` so the gate's Rule 0 can downgrade any
  // LLM-declared qualityTier that exceeds the code-side ground truth.
  // RFC financials Phase 1: when the pack carries facts.financials, the
  // dim MUST declare 'financials' in factReferences[] (FUNDAMENTAL +
  // VALUATION are the only consumers per §3.8). Soft-warn, no reject.
  const packV2 =
    options.evidencePack?.schemaVersion === 'evidence-pack-v2'
      ? options.evidencePack
      : undefined;
  const requiredFactReferences: string[] = [];
  if (
    packV2?.facts.financials &&
    (sectionType === 'FUNDAMENTAL' || sectionType === 'VALUATION')
  ) {
    requiredFactReferences.push('financials');
  }
  const gated = applyEvidenceGate(structured.data, {
    ...(options.domainTiers ? { domainTiers: options.domainTiers } : {}),
    ...(requiredFactReferences.length > 0
      ? { requiredFactReferences }
      : {}),
  });
  const fixedData = applyFixedDisclaimer(gated.data);

  yield {
    type: 'structured_data',
    runId,
    seq: next(),
    sectionType,
    json: fixedData,
  };

  // (cost_update emission moved to workflow layer for run-wide cumulatives)

  const totalToolCalls = Object.values(finalStream.toolUseCounts ?? {}).reduce(
    (s, n) => s + n,
    0,
  );
  const streamCostUsd = computeUsd(
    finalStream.model,
    finalStream.usage?.tokensIn ?? 0,
    finalStream.usage?.tokensOut ?? 0,
  );
  const structuredCostUsd = computeUsd(
    structured.model,
    structured.usage.tokensIn,
    structured.usage.tokensOut,
  );

  // RFC-01: aggregate cache + webSearch telemetry across stream + structured
  // passes. Each component is omitted from the SSE payload when it's 0 so
  // existing UI consumers (apps/web) don't see noise for runs without cache
  // (Phase 3 not yet rolled out) or without web_search (debate sub-paths).
  const cacheReadTotal =
    (finalStream.usage?.cacheReadInputTokens ?? 0) +
    (structured.usage.cacheReadInputTokens ?? 0);
  const cacheCreationTotal =
    (finalStream.usage?.cacheCreationInputTokens ?? 0) +
    (structured.usage.cacheCreationInputTokens ?? 0);
  const webSearchRequestsTotal =
    (finalStream.usage?.webSearchRequests ?? 0) +
    (structured.usage.webSearchRequests ?? 0);
  const webSearchErrorsCount = finalStream.webSearchErrors?.length ?? 0;

  yield {
    type: 'section_complete',
    runId,
    seq: next(),
    sectionType,
    status: 'COMPLETED',
    usage: {
      tokensIn:
        (finalStream.usage?.tokensIn ?? 0) + structured.usage.tokensIn,
      tokensOut:
        (finalStream.usage?.tokensOut ?? 0) + structured.usage.tokensOut,
      // 1 stream + N structured-output complete (1 or 2 with repair)
      llmCalls: 1 + structured.llmCalls,
      toolCalls: totalToolCalls,
      durationMs: Date.now() - startedAt,
      citationsCount: finalStream.citations.length,
      costUsd: streamCostUsd + structuredCostUsd,
      ...(cacheReadTotal > 0 ? { cacheReadInputTokens: cacheReadTotal } : {}),
      ...(cacheCreationTotal > 0
        ? { cacheCreationInputTokens: cacheCreationTotal }
        : {}),
      ...(webSearchRequestsTotal > 0
        ? { webSearchRequests: webSearchRequestsTotal }
        : {}),
      ...(webSearchErrorsCount > 0 ? { webSearchErrorsCount } : {}),
    },
  };
}
