import type { EvidencePackV2 } from '../contracts/evidence-pack-v2';
import type { SseEvent } from '../contracts/sse-events';
import { enforceComputedValueRanges, hasComputedValuationFact, validateValuationSemantics, degradeValuationSemantics, SectionResult } from '../contracts/analysis-result';
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
import { applyResearchCoverage } from '../snapshot/research-coverage';
import type {
  AgentProvider,
  ProviderUsage,
  ProviderStreamResult,
  SystemPromptInput,
} from './provider';
import { structuredOutputWithRepair, parseStructured, mergeProviderUsage } from './structured-output';
import { StructuredOutputError } from './errors';
import { HallucinationFilter } from '../tools/web-search/hallucination-filter';

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
   * Immutable EvidencePack v2 produced by the Snapshot stage. The workflow
   * owns its lifetime and reuses it for retries; this function only reads it.
   */
  evidencePack?: EvidencePackV2;
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
  /** Fixed per-module web-search cap owned by the selected research mode. */
  maxToolCalls?: number;
  /** Fixed streamed-report output cap owned by the selected research mode. */
  maxOutputTokens?: number;
  /** Fixed structured-card output cap owned by the selected research mode. */
  maxStructuredTokens?: number;
  /** Hard wall-clock limit for the whole module, including structured output. */
  timeoutMs?: number;
}

class DimensionTimeoutError extends Error {
  constructor(sectionType: string, timeoutMs: number) {
    super(`Analysis section ${sectionType} timed out after ${timeoutMs}ms`);
    this.name = 'DimensionTimeoutError';
  }
}

function abortError(reason?: unknown): Error {
  if (reason instanceof Error) return reason;
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  return error;
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

  const evidenceBlock = options.evidencePack
    ? `${formatEvidencePackBlock(options.evidencePack, sectionType)}\n\n`
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
  const reportFilter = new HallucinationFilter();
  let reportDeliveryMode: 'unknown' | 'markdown' | 'structured' = 'unknown';
  let reportProbe = '';
  let resumeIter: (() => void) | null = null;
  let wake = (): void => {
    if (resumeIter !== null) {
      const r = resumeIter;
      resumeIter = null;
      r();
    }
  };

  // Use one internal signal so provider streaming and structured extraction
  // share the same caller-cancellation and module-timeout boundary.
  const moduleController = new AbortController();
  let callerAborted = options.signal?.aborted === true;
  let timedOut = false;
  const timeoutMs = options.timeoutMs;
  const timeoutError =
    typeof timeoutMs === 'number' && timeoutMs > 0
      ? new DimensionTimeoutError(sectionType, timeoutMs)
      : null;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  let boundaryReject: ((reason: unknown) => void) | null = null;
  const moduleBoundary = timeoutError
    ? new Promise<never>((_, reject) => {
        boundaryReject = reject;
      })
    : null;
  // The boundary is created before the stream starts, so attach a handler now
  // even though it is only awaited during structured extraction. This keeps a
  // timeout rejection from being reported as an unhandled promise rejection
  // while the streamed report is still draining.
  if (moduleBoundary) void moduleBoundary.catch(() => undefined);
  const abortFromCaller = () => {
    callerAborted = true;
    if (!moduleController.signal.aborted) {
      moduleController.abort(options.signal?.reason);
    }
    boundaryReject?.(abortError(options.signal?.reason));
    wake();
  };

  if (options.signal) {
    if (options.signal.aborted) abortFromCaller();
    else options.signal.addEventListener('abort', abortFromCaller, { once: true });
  }
  if (timeoutError) {
    timeoutHandle = setTimeout(() => {
      timedOut = true;
      if (!moduleController.signal.aborted) moduleController.abort(timeoutError);
      boundaryReject?.(timeoutError);
      wake();
    }, timeoutMs!);
  }
  const cleanup = () => {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    options.signal?.removeEventListener('abort', abortFromCaller);
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
        if (reportDeliveryMode === 'structured') return;
        if (reportDeliveryMode === 'unknown') {
          reportProbe += chunk.text;
          const trimmed = reportProbe.trimStart();
          // A leading `[` is also a normal Markdown link/list. Structured
          // module output is an object, so only `{` is safe to classify here.
          const looksLikeJson = /^\{/.test(trimmed) || /^```\s*json\b/i.test(trimmed);
          const looksLikeMarkdown = trimmed.length > 0 && !looksLikeJson;
          if (!looksLikeJson && !looksLikeMarkdown) return;
          reportDeliveryMode = looksLikeJson ? 'structured' : 'markdown';
          if (reportDeliveryMode === 'structured') {
            reportProbe = '';
            return;
          }
          chunk = { type: 'text', text: reportProbe };
          reportProbe = '';
        }
        const cleaned = reportFilter.feed(chunk.text);
        if (cleaned) {
          queue.push({
            type: 'report_chunk',
            runId,
            seq: next(),
            sectionType,
            deltaText: cleaned,
          });
        }
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
      signal: moduleController.signal,
      ...(options.maxToolCalls ? { maxToolUses: options.maxToolCalls } : {}),
      ...(options.maxOutputTokens ? { maxTokens: options.maxOutputTokens } : {}),
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

  while ((!settled && !callerAborted && !timedOut) || queue.length > 0) {
    while (queue.length > 0) {
      const evt = queue.shift();
      if (evt !== undefined) yield evt;
    }
    if (!settled && !callerAborted && !timedOut) {
      await new Promise<void>((resolve) => {
        resumeIter = resolve;
      });
    }
  }

  if (timedOut) {
    cleanup();
    throw timeoutError;
  }
  if (callerAborted) {
    cleanup();
    throw abortError(options.signal?.reason);
  }
  if (streamError !== null) {
    cleanup();
    throw streamError;
  }
  if (streamResult === null) {
    cleanup();
    throw new Error('streamDimension: provider.stream resolved without result');
  }

  const finalStream: ProviderStreamResult = streamResult;
  if ((reportDeliveryMode as string) !== 'structured' && reportProbe) {
    const cleaned = reportFilter.feed(reportProbe);
    if (cleaned) {
      yield {
        type: 'report_chunk',
        runId,
        seq: next(),
        sectionType,
        deltaText: cleaned,
      };
    }
    reportProbe = '';
  }
  const filterTail = reportFilter.flush();
  if (filterTail) {
    yield {
      type: 'report_chunk',
      runId,
      seq: next(),
      sectionType,
      deltaText: filterTail,
    };
  }

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
  let structured: {
    data: SectionResult;
    usage: ProviderUsage;
    llmCalls: number;
  };
  try {
    const structuredPromise = structuredOutputWithRepair<SectionResult>(
      provider,
      jsonPrompts.system,
      jsonPrompts.user,
      dimension.outputSchema,
      // Keep the extraction response bounded. The report itself can be long,
      // but the validated card is intentionally compact so providers do not
      // truncate a JSON array halfway through a risk list.
      {
        signal: moduleController.signal,
        maxTokens: options.maxStructuredTokens ?? 6_000,
      },
    );
    structured = moduleBoundary
      ? await Promise.race([
          structuredPromise,
          moduleBoundary,
        ])
      : await structuredPromise;
  } catch (error) {
    cleanup();
    throw error;
  }

  // Plan 3 §4.3.4: A-E quality gate (E-only removal + AB-ratio checks).
  // RFC-06: pass `domainTiers` so the gate's Rule 0 can downgrade any
  // LLM-declared qualityTier that exceeds the code-side ground truth.
  // When the pack carries facts.financials, the company-quality and valuation
  // modules declare 'financials' in their factReferences[]. Soft-warn, no
  // reject.
  const isV2Pack = options.evidencePack?.schemaVersion === 'evidence-pack-v2';
  const coverage =
    isV2Pack
      ? options.evidencePack?.researchCoverage?.dimensions[sectionType]
      : undefined;
  // FUNCTIONAL.md (估值): without a code-computed valuation the scenario
  // valueRange must be null; enforce it here instead of trusting the prompt.
  // Visualization §四.④ (R-4): the shared predicate keeps the enforcer and
  // the post-chain semantic validator on the same definition.
  const computedValuationPresent = isV2Pack
    ? hasComputedValuationFact(options.evidencePack?.computedFacts)
    : false;
  const postChain = (raw: SectionResult): SectionResult =>
    enforceComputedValueRanges(
      applyFixedDisclaimer(
        applyResearchCoverage(
          applyEvidenceGate(raw, {
            ...(options.domainTiers ? { domainTiers: options.domainTiers } : {}),
          }).data,
          coverage,
        ),
      ),
      computedValuationPresent,
    );
  let fixedData = postChain(structured.data);

  // Visualization §四.④ — post-chain semantic validation for VALUATION (the
  // root fix lives in the extraction prompt; this is the rare-path backstop).
  // Flow: validate AFTER enforce (R-4) → one repair call with the gap list →
  // re-run chain + re-validate → pass | degrade-with-limitations. Schema
  // failure of the repair call throws (existing StructuredOutputError
  // semantics); semantic shortfall degrades instead of fabricating.
  if (sectionType === 'VALUATION_SCENARIOS') {
    const verdict = validateValuationSemantics(fixedData, computedValuationPresent);
    if (!verdict.ok) {
      const repairUser =
        `${jsonPrompts.user}\n\n上一次输出存在以下语义问题，请修复后重新输出完整 JSON（只输出 JSON，不要解释）：\n` +
        verdict.gaps.map((g) => `- ${g}`).join('\n');
      let second: Awaited<ReturnType<AgentProvider['complete']>>;
      let parsed: ReturnType<typeof parseStructured<SectionResult>>;
      try {
        second = await provider.complete(jsonPrompts.system, repairUser, {
          signal: moduleController.signal,
          maxTokens: options.maxStructuredTokens ?? 6_000,
        });
        parsed = parseStructured<SectionResult>(second.text, dimension.outputSchema);
      } catch (error) {
        cleanup();
        throw error;
      }
      if (!parsed.success) {
        throw new StructuredOutputError(
          `Valuation semantic repair failed schema: ${parsed.error}`,
          parsed.error,
        );
      }
      const repaired = postChain(parsed.data);
      const verdict2 = validateValuationSemantics(repaired, computedValuationPresent);
      fixedData = verdict2.ok ? repaired : degradeValuationSemantics(repaired, verdict2.gaps);
      // Merge repair cost into the section usage ledger (degrade never hides cost).
      structured = {
        data: structured.data,
        usage: mergeProviderUsage(structured.usage, second.usage),
        llmCalls: structured.llmCalls + 1,
      };
    }
  }

  // The report stream is user-facing text, but a provider may still return a
  // structured JSON object despite the prompt. Emit one final replacement so
  // the persisted report and the browser do not retain raw JSON/tool syntax.
  yield {
    type: 'report_complete',
    runId,
    seq: next(),
    sectionType,
    fullMarkdown: normalizeReportMarkdown(finalStream.text, fixedData),
  };

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
  cleanup();
}

function normalizeReportMarkdown(raw: string, structured: SectionResult): string {
  const filter = new HallucinationFilter();
  const cleaned = `${filter.feed(raw)}${filter.flush()}`;
  const trimmed = cleaned.trim();
  if (!/^(?:\{|\[|```(?:json)?\b)/i.test(trimmed)) return cleaned;

  const candidate = parseJsonObject(trimmed);
  if (candidate && typeof candidate.summary === 'string') {
    return formatSectionMarkdown(candidate);
  }
  return formatSectionMarkdown(structured);
}

function parseJsonObject(value: string): Record<string, any> | null {
  const unwrapped = value
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();
  try {
    const parsed: unknown = JSON.parse(unwrapped);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, any>
      : null;
  } catch {
    return null;
  }
}

function formatSectionMarkdown(result: Record<string, any>): string {
  const lines: string[] = [];
  if (typeof result.summary === 'string' && result.summary.trim()) {
    lines.push(result.summary.trim());
  }
  if (Array.isArray(result.findings) && result.findings.length > 0) {
    lines.push('', '### 关键发现');
    for (const finding of result.findings) {
      if (!finding || typeof finding !== 'object') continue;
      const title = typeof finding.title === 'string' ? finding.title : '发现';
      const conclusion = typeof finding.conclusion === 'string' ? finding.conclusion : '';
      lines.push(`- **${title}**${conclusion ? `：${conclusion}` : ''}`);
    }
  }
  if (Array.isArray(result.limitations) && result.limitations.length > 0) {
    lines.push('', '### 局限');
    lines.push(...result.limitations.filter((item: unknown): item is string => typeof item === 'string').map((item) => `- ${item}`));
  }
  return lines.join('\n') || '本模块未生成可展示的正文。';
}
