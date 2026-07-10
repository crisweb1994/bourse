import type { AnalysisResult } from '../contracts/analysis-result';
import type { Citation } from '../contracts/citation';
import type { RunStatus, SectionType } from '../contracts/enums';
import type { EvidencePackAny } from '../contracts/evidence-pack';
import type { SseEvent } from '../contracts/sse-events';
import { ALL_DIMENSIONS } from '../dimensions';
import type { Dimension, DimensionRunResult } from '../dimensions/types';
import { computeUsd } from '../primitives/pricing';
import type { AgentProvider } from '../primitives/provider';
import { ToolMiddlewareRunner } from '../tools/middleware';
import { runJudge, shouldJudge } from '../primitives/judge';
import { formatEvidencePackBlock } from '../primitives/dimension-prompts';
import {
  type SectionForValidation,
  validateCrossDim,
} from '../primitives/validate-cross-dim';
import {
  findFailRunOffenders,
  groupByWave,
  runWithSemaphore,
} from './wave-executor';
import {
  buildSectionReports,
  buildSummaryPrompts,
} from '../primitives/summary-prompts';
import type {
  BudgetLimits,
  ComprehensiveOptions,
  ComprehensiveResult,
  DimensionFailure,
  DimensionInput,
} from './types';

// refactor-v1 Wave 4: 纯函数 helpers 抽到 ./comprehensive-helpers
import {
  applyConfidenceDowngrade,
  assertLegacyParallelCompatible,
  buildResult,
  buildSectionsForValidation,
  checkBudget,
  deriveMarketRouting,
  filterDegradedDims,
  selectJudgeTriggers,
  toAnalysisResult,
} from './comprehensive-helpers';

// 异步 IO + 解析链 helpers (evidence pack 重建 / summary 结构化解析)
import {
  parseSummaryStructured,
  resolveEvidencePack,
} from './comprehensive-async-helpers';

// 执行策略 helpers (wave / parallel harvest + drain / sequential stream-through)
import {
  applyHarvest,
  emitTerminalDone,
  harvestDimBuffered,
  runSequentialStrategy,
  type HarvestCollections,
  type HarvestContext,
  type HarvestTotals,
  type SeqHandle,
} from './comprehensive-strategies';

/**
 * RFC-10 §7.2: cap on parallel judge invocations. Selective judge phase
 * runs after the validator and before summary; capping concurrency keeps
 * burst spend bounded and protects the summary phase from being blocked
 * by a slow judge call. 3 is a balance — at most ~3-5 dims typically
 * trigger judge (HIGH/strong skew), so 3 keeps tail latency low while
 * fitting most runs in a single batch.
 */
const JUDGE_CONCURRENCY = 3;

/**
 * Comprehensive workflow: run all 8 dimensions sequentially, then generate
 * a summary. Yields per-dim SseEvents, summary_chunk × N, summary_complete,
 * cost_update at boundaries, and a final `done` event with the comprehensive
 * payload.
 *
 * Honors `dim.onFailure`:
 *   - 'skip'        → log failure, continue to next dim
 *   - 'retry-once'  → re-run streamDimension once; on second failure, skip
 *   - 'fail-run'    → halt before summary, emit done with status=FAILED
 *
 * Honors configured budget caps between sections: when cumulative usage
 * reaches a cap, halt before the next dim with status=BUDGET_EXHAUSTED.
 *
 * Returns ComprehensiveResult via TReturn so callers using explicit
 * generator iteration can consume it.
 */
export async function* streamComprehensive(
  provider: AgentProvider,
  input: DimensionInput,
  options: ComprehensiveOptions,
): AsyncGenerator<SseEvent, ComprehensiveResult, undefined> {
  let dims = options.dimensions ?? ALL_DIMENSIONS;
  const { runId } = options;
  const todayDate =
    options.todayDate ?? new Date().toISOString().slice(0, 10);
  const budget: BudgetLimits = options.budget ?? {};
  let seq = options.startSeq ?? 0;

  // Parallel mode is incompatible with budget enforcement and fail-run
  // semantics — Promise.all can't synchronously halt sibling dims.
  // Fail loudly rather than silently downgrade.
  // RFC-05: waveMode takes precedence — when caller sets waveMode (any value),
  // we skip the legacy parallel validation and let the wave / sequential
  // branches decide.
  assertLegacyParallelCompatible(options, dims);

  // RFC-06: derive source-routing config once. When `marketProfile.domainTiers`
  // is set (currently CN only), we (a) constrain provider web_search to those
  // hosts and (b) feed the full table to evidence-gate so it can downgrade
  // LLM-declared `qualityTier` that exceeds the code-side tier. The CN table
  // is intentionally A|B|C|D only — E is implicit absence — so a bare
  // `Object.keys(...)` already excludes E. We still filter explicitly so a
  // future market that lists E entries (e.g. as a denylist) is safe.
  const { domainTiers: marketDomainTiers, allowedDomains: marketAllowedDomains } =
    deriveMarketRouting(options.marketProfile);

  const dimResults = new Map<SectionType, DimensionRunResult>();
  const failures: DimensionFailure[] = [];
  const allCitations: Citation[] = [];
  const allWarnings: string[] = [];
  let aggregatedTokensIn = 0;
  let aggregatedTokensOut = 0;
  let aggregatedLlmCalls = 0;
  let aggregatedToolCalls = 0;
  let aggregatedCostUsd = 0;

  // Day 11.5b: every per-tool invocation goes through ToolMiddleware
  // (CLAUDE.md §3 #16). Runner observes + computes cost; workflow's
  // own overBudget() check (using the same aggregated totals) is the
  // authoritative gate, so we don't pass maxTotalCalls here to avoid
  // double-throw on the same breach.
  const toolMiddleware = new ToolMiddlewareRunner({});
  /** Record tool invocations from a finished provider.stream. */
  const recordToolUses = (
    toolUseCounts: Record<string, number> | undefined,
    streamUsage?: { tokensIn: number; tokensOut: number },
  ): void => {
    if (!toolUseCounts) return;
    for (const [name, count] of Object.entries(toolUseCounts)) {
      for (let n = 0; n < count; n++) {
        toolMiddleware.record({
          toolName: name,
          startedAt: Date.now(),
          durationMs: 0,
          citationsCount: 0,
          // Apportion stream usage equally across tool invocations so
          // pricing functions (when supplied) see something sensible.
          tokensIn: streamUsage ? Math.floor(streamUsage.tokensIn / count) : 0,
          tokensOut: streamUsage ? Math.floor(streamUsage.tokensOut / count) : 0,
        });
      }
    }
  };
  const perDimTrace = new Map<
    SectionType,
    {
      durationMs: number;
      citationsCount: number;
      tokensIn: number;
      tokensOut: number;
      llmCalls: number;
      toolCalls: number;
    }
  >();
  const workflowStartedAt = Date.now();

  // Evidence pack resolution:
  //  1. options.evidencePack — Path A: the consumer (apps/api) pre-builds it via
  //     connector → compute → snapshotToEvidencePack (+ CN tool signals). This is
  //     the sole structured-pack source in production.
  //  2. Market-agnostic web_search recovery (any market) when the resolved pack
  //     is absent or critically degraded (no `financials`).
  let evidencePack: EvidencePackAny | undefined = options.evidencePack;

  // No-usable-data recovery: ONLY when the structured fetch produced nothing
  // worth keeping — no pack at all, or a pack with neither quote nor financials
  // — rebuild via the controlled v1 LLM web_search builder so the run yields a
  // result instead of an empty/failed analysis. Partial degradation (some data
  // present, e.g. quote present but financials missing) is NOT recovered this
  // way: the V2 pack is kept and each dim fills the gaps per-field
  // (marked) — we never discard good code-verified data. `allowWebSearchFallback`
  // is the recovery-enabled switch; apps/api turns it on for production runs.
  // The rebuilt pack is stamped degradedSource=WEB_SEARCH_FALLBACK, so its
  // web-sourced numbers are clearly marked non-authoritative (never fed to
  // compute as if code-verified — hard invariant #1) and private-data dims skip.
  evidencePack = await resolveEvidencePack(
    provider,
    input,
    {
      evidencePack,
      allowWebSearchFallback: options.allowWebSearchFallback === true,
      ...(options.todayDate ? { todayDate: options.todayDate } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    },
  );

  // Consumers derive degraded state from pack.dataAvailability.degradedSource.
  if (evidencePack) {
    yield {
      type: 'evidence_pack_ready',
      runId,
      seq: seq++,
      pack: evidencePack as never, // SSE schema accepts EvidencePackAny via discriminatedUnion
    };
  }

  // RFC rfc-evidence-pack-web-search-fallback §2.4: skip dims whose
  // `requiresPrivateData` cannot be reconstructed from the current pack.
  // Only runs when the pack is web_search-degraded; under normal v1/v2
  // packs `missingPrivateFields` is empty so this is a no-op.
  {
    const pack = evidencePack as
      | {
          dataAvailability?: {
            degradedSource?: 'NONE' | 'WEB_SEARCH_FALLBACK';
            missingPrivateFields?: ReadonlyArray<
              'northboundFlow' | 'lhb' | 'unlockCalendar' | 'consensusEps'
            >;
          };
        }
      | undefined;
    const da = pack?.dataAvailability;
    if (
      da?.degradedSource === 'WEB_SEARCH_FALLBACK' &&
      da.missingPrivateFields &&
      da.missingPrivateFields.length > 0
    ) {
      const missing = new Set(da.missingPrivateFields);
      const { kept, skipped } = filterDegradedDims(dims, missing);
      for (const { dim, missingFields } of skipped) {
        yield {
          type: 'section_skipped',
          runId,
          seq: seq++,
          sectionType: dim.type,
          reason: 'DEGRADED_SOURCE_MISSING_PRIVATE_DATA',
          missingFields: missingFields as never,
        };
        failures.push({
          type: dim.type,
          error: `degraded-source-missing-${missingFields.join(',')}`,
        });
      }
      dims = kept as readonly Dimension[];
    }
  }

  // Helper: detect budget exhaustion (inclusive: a cap reached exactly
  // must halt before the next dim starts — comprehensive checks pre-dim).
  const overBudget = ():
    | false
    | 'maxTokens'
    | 'maxCostUsd'
    | 'maxToolCalls' =>
    checkBudget(
      budget,
      {
        tokens: aggregatedTokensIn + aggregatedTokensOut,
        costUsd: aggregatedCostUsd,
        toolCalls: aggregatedToolCalls,
      },
      true,
    );

  // RFC-05: wave mode. Takes precedence over legacy `parallel`.
  // - waveMode 'auto': group dims by wave, run with semaphore, gate
  //   budget/fail-run between waves. Default semaphore = 4.
  // - waveMode 'disabled' or 'sequential': skip both wave + parallel
  //   branches, drop into the for-loop sequential path below.
  // - waveMode undefined: fall through to legacy `parallel`/sequential
  //   logic (keeps RFC-05 a backward-compat opt-in).
  const resolvedWaveMode: 'auto' | 'disabled' | undefined =
    options.waveMode === 'sequential'
      ? 'disabled'
      : options.waveMode;
  const waveSemaphore = options.waveSemaphore ?? 4;

  // Shared harvest context — wave and parallel modes both feed per-dim
  // harvests through the helpers in ./comprehensive-strategies.
  const harvestCtx: HarvestContext = {
    provider,
    input,
    runId,
    todayDate,
    signal: options.signal,
    evidencePack,
    marketAllowedDomains,
    marketDomainTiers,
  };
  // Collections are passed by reference (applyHarvest mutates them in place).
  const harvestCollections: HarvestCollections = {
    dimResults,
    failures,
    allCitations,
    allWarnings,
    perDimTrace,
    toolMiddleware,
  };
  // Running totals are bound to the generator's local accumulators via
  // get/set so applyHarvest's `totals.x += ...` updates the locals directly
  // — keeping a single source of truth (the locals) without rewriting every
  // downstream reference in the summary / buildResult phases.
  const harvestTotals: HarvestTotals = {
    get tokensIn() {
      return aggregatedTokensIn;
    },
    set tokensIn(v) {
      aggregatedTokensIn = v;
    },
    get tokensOut() {
      return aggregatedTokensOut;
    },
    set tokensOut(v) {
      aggregatedTokensOut = v;
    },
    get llmCalls() {
      return aggregatedLlmCalls;
    },
    set llmCalls(v) {
      aggregatedLlmCalls = v;
    },
    get toolCalls() {
      return aggregatedToolCalls;
    },
    set toolCalls(v) {
      aggregatedToolCalls = v;
    },
    get costUsd() {
      return aggregatedCostUsd;
    },
    set costUsd(v) {
      aggregatedCostUsd = v;
    },
  };
  const nextSeq = (): number => seq++;

  if (resolvedWaveMode === 'auto') {
    // Global order is preserved by feeding each dim its original index
    // from the canonical dims[] array — events drained per-wave still
    // sort the same as the legacy parallel path.
    const waveGroups = groupByWave(dims);
    let waveAborted: 'budget' | 'fail-run' | null = null;
    let abortReason = '';

    waveLoop: for (const group of waveGroups) {
      // Budget pre-check (RFC-05 §7).
      const breach = overBudget();
      if (breach) {
        yield {
          type: 'error',
          runId,
          seq: seq++,
          message: `Budget exhausted (${breach}); halting before wave ${group.wave}`,
          recoverable: false,
        };
        waveAborted = 'budget';
        abortReason = breach;
        break waveLoop;
      }

      const tasks = group.dims.map((dim) => {
        const i = dims.indexOf(dim);
        return () => harvestDimBuffered(harvestCtx, dim, i);
      });
      const settled = await runWithSemaphore(tasks, waveSemaphore);
      const harvests = settled.flatMap((r) =>
        r.status === 'fulfilled' ? [r.value] : [],
      );

      // Drain in dim order, renumber seq globally, accumulate state.
      for (const h of harvests) {
        yield* applyHarvest(
          h,
          harvestCollections,
          harvestTotals,
          runId,
          nextSeq,
        );
      }

      // Fail-run gate (RFC-05 §7): if any fail-run dim in this wave
      // failed, halt before the next wave.
      const failedTypes = new Set(failures.map((f) => f.type));
      const offenders = findFailRunOffenders(group.dims, failedTypes);
      if (offenders.length > 0) {
        yield {
          type: 'error',
          runId,
          seq: seq++,
          message: `fail-run dimension(s) failed in wave ${group.wave}: ${offenders.map((d) => d.type).join(', ')}; halting before next wave`,
          recoverable: false,
        };
        waveAborted = 'fail-run';
        abortReason = offenders.map((d) => d.type).join(',');
        break waveLoop;
      }
    }

    if (waveAborted === 'budget') {
      // Emit terminal done + return. Build result with BUDGET_EXHAUSTED
      // status; partial dims completed so far remain in dimResults.
      // (buildResult derives partialDimensions internally from
      // dimResults + failures; we don't pass them explicitly here.)
      void abortReason;
      const result = yield* emitTerminalDone(
        {
          status: 'BUDGET_EXHAUSTED' as RunStatus,
          dimResults,
          failures,
          summary: null,
          allCitations,
          allWarnings,
          aggregatedTokensIn,
          aggregatedTokensOut,
          aggregatedLlmCalls,
          aggregatedToolCalls,
          aggregatedCostUsd,
          perDimTrace,
          workflowStartedAt,
        },
        runId,
        nextSeq,
      );
      return result;
    }
    if (waveAborted === 'fail-run') {
      const result = yield* emitTerminalDone(
        {
          status: 'FAILED' as RunStatus,
          dimResults,
          failures,
          summary: null,
          allCitations,
          allWarnings,
          aggregatedTokensIn,
          aggregatedTokensOut,
          aggregatedLlmCalls,
          aggregatedToolCalls,
          aggregatedCostUsd,
          perDimTrace,
          workflowStartedAt,
        },
        runId,
        nextSeq,
      );
      return result;
    }
    // All waves done — fall through to summary phase.
  } else if (options.parallel && resolvedWaveMode !== 'disabled') {
    const harvests = await Promise.all(
      dims.map((dim, i) => harvestDimBuffered(harvestCtx, dim, i)),
    );

    // Drain in dim order, renumber seq globally, accumulate state.
    for (const h of harvests) {
      yield* applyHarvest(h, harvestCollections, harvestTotals, runId, nextSeq);
    }
    // Fall through to summary phase (parallel mode skips sequential loop).
  } else {
    // ===== Sequential mode (default) =====
    // Per-dimension streaming with retry-once + fail-run support. Isolated
    // in runSequentialStrategy (./comprehensive-strategies) because, unlike
    // wave/parallel, it streams events through inline (no buffering) and
    // checks budget at dim granularity.
    const seqHandle: SeqHandle = {
      get: () => seq,
      set: (v) => {
        seq = v;
      },
      next: () => seq++,
    };
    const outcome = yield* runSequentialStrategy({
      dims,
      harvestCtx,
      collections: harvestCollections,
      totals: harvestTotals,
      budget,
      workflowStartedAt,
      overBudget,
      seq: seqHandle,
    });
    if (outcome.status === 'terminal') {
      return outcome.result;
    }
  }

  // ===== Summary phase =====
  if (dimResults.size === 0) {
    const result = yield* emitTerminalDone(
      {
        status: 'FAILED' as RunStatus,
        dimResults,
        failures,
        summary: null,
        allCitations,
        allWarnings,
        aggregatedTokensIn,
        aggregatedTokensOut,
        aggregatedLlmCalls,
        aggregatedToolCalls,
        aggregatedCostUsd,
        perDimTrace,
        workflowStartedAt,
      },
      runId,
      nextSeq,
    );
    return result;
  }

  // ===== RFC-03 Cross-dim Validator =====
  // After all dims have produced output but before we synthesize a summary,
  // run a consistency check across dims. Validator mutates section
  // confidence in place on DOWNGRADE conflicts; on FAIL we emit an error
  // + halt before summary (per RFC-03 §4 decision: keep completed dims
  // visible to the user but suppress the cross-dim summary).
  if (options.marketProfile && dimResults.size > 0) {
    const v2Pack =
      evidencePack?.schemaVersion === 'evidence-pack-v2'
        ? evidencePack
        : undefined;
    const sectionsForValidation: SectionForValidation[] =
      buildSectionsForValidation(dimResults);

    if (sectionsForValidation.length > 0) {
      const validatorReport = validateCrossDim(sectionsForValidation, {
        evidencePack: v2Pack,
        marketProfile: options.marketProfile,
      });

      // plan-v2 Wave 3.3: cross_dim_warning SSE event removed. Validator
      // still runs and downgrades confidence in-place; conflict messages
      // still fold into `allWarnings` so the final ComprehensiveResult
      // carries an auditable trace.
      if (validatorReport.conflicts.length > 0) {
        for (const c of validatorReport.conflicts) {
          allWarnings.push(`[cross-dim:${c.severity}] ${c.message}`);
        }
      }

      // FAIL halts before summary; PARTIAL_FAILED status retains all
      // completed dim outputs so the user can still see per-section content.
      if (validatorReport.overallStatus === 'FAIL') {
        yield {
          type: 'error',
          runId,
          seq: seq++,
          message: `Cross-dim validator detected ${validatorReport.summary.severityCounts.FAIL} FAIL conflict(s); summary skipped to surface the discrepancy`,
          recoverable: false,
        };
        const result = yield* emitTerminalDone(
          {
            status: 'PARTIAL_FAILED' as RunStatus,
            dimResults,
            failures,
            summary: null,
            allCitations,
            allWarnings,
            aggregatedTokensIn,
            aggregatedTokensOut,
            aggregatedLlmCalls,
            aggregatedToolCalls,
            aggregatedCostUsd,
            perDimTrace,
            workflowStartedAt,
          },
          runId,
          nextSeq,
        );
        return result;
      }

      // ===== RFC-10 Selective Judge phase =====
      // After validator survives (no FAIL), audit dims that `shouldJudge`
      // selects: HIGH+BULLISH/BEARISH, Tier D/E ratio > 50%, or cross-dim
      // WARNING/DOWNGRADE on that dim. Triggered dims run runJudge() in
      // parallel under JUDGE_CONCURRENCY; results apply confidence downgrades
      // to dim.structuredJson.conclusion.confidence + dim.confidence in
      // place before summary phase reads them. Judge failures degrade
      // gracefully (warning, no adjustment) and don't block summary.
      const judgeTriggers = selectJudgeTriggers(
        sectionsForValidation,
        dimResults,
        ALL_DIMENSIONS,
        validatorReport.conflicts,
        shouldJudge,
      );

      if (judgeTriggers.length > 0) {
        // Pre-fire all judge_start so consumers see the audit underway
        // before we await the slowest judge.
        for (const t of judgeTriggers) {
          yield {
            type: 'judge_start',
            runId,
            seq: seq++,
            sectionType: t.type,
          };
        }

        const evidencePackText = v2Pack
          ? formatEvidencePackBlock(v2Pack)
          : '';
        const judgeOutcomes = await runWithSemaphore(
          judgeTriggers.map((t) => async () => {
            const out = await runJudge(
              provider,
              {
                dimensionType: t.type,
                evidencePackText,
                structuredJson: t.dimResult.structuredJson,
                reportMarkdown: t.dimResult.reportMarkdown,
                citations: t.dimResult.citations,
                ...(t.severity ? { crossDimSeverity: t.severity } : {}),
              },
              options.signal ? { signal: options.signal } : {},
            );
            return { type: t.type, out };
          }),
          JUDGE_CONCURRENCY,
        );

        for (let i = 0; i < judgeOutcomes.length; i++) {
          const settled = judgeOutcomes[i]!;
          const t = judgeTriggers[i]!;
          if (settled.status === 'fulfilled') {
            const { type, out } = settled.value;
            applyConfidenceDowngrade(
              dimResults,
              type,
              out.result.confidenceAdjustment,
            );
            aggregatedTokensIn += out.trace.tokensIn;
            aggregatedTokensOut += out.trace.tokensOut;
            aggregatedLlmCalls += out.trace.llmCalls;
            aggregatedCostUsd += out.trace.costUsd;
            yield {
              type: 'judge_complete',
              runId,
              seq: seq++,
              sectionType: type,
              result: out.result,
              traceTokensIn: out.trace.tokensIn,
              traceTokensOut: out.trace.tokensOut,
              traceCostUsd: out.trace.costUsd,
              traceDurationMs: out.trace.durationMs,
            };
          } else {
            const msg =
              settled.reason instanceof Error
                ? settled.reason.message
                : String(settled.reason);
            allWarnings.push(`[judge:fail:${t.type}] ${msg}`);
          }
        }
      }
    }
  }

  const succeededTypes = Array.from(dimResults.keys());
  const failedTypes = failures.map((f) => f.type);
  const sectionReports = buildSectionReports(dimResults);
  const summaryPrompts = buildSummaryPrompts(
    sectionReports,
    todayDate,
    succeededTypes,
    failedTypes,
  );

  // Buffered streaming: collect chunks via callback, then yield as
  // summary_chunk events.
  //
  // `disableTools: true` is critical — the summary stage receives the 9
  // already-researched dimension reports as input. Letting the model call
  // `web_search` here causes a cascade: native-tool models (mimo / deepseek
  // chat.completions path) emit tool_calls instead of text, the wired
  // executor fires N rounds against the user's WebSearchSetting (Tavily
  // etc.), and any upstream issue (quota 432, network) turns every round
  // into an error result. After CHAT_COMPLETIONS_MAX_TOOL_ROUNDS the loop
  // forces a stop but the model often outputs nothing usable, leaving
  // Analysis.status=FAILED + summaryMarkdown=NULL. Diagnosed from the
  // 9988.HK incident (cmpiaq0zr00019ko4mswv054b, 2026-05-23).
  const chunkBuffer: string[] = [];
  const summaryStream = await provider.stream(
    summaryPrompts.system,
    summaryPrompts.user,
    (chunk) => {
      if (chunk.type === 'text') {
        chunkBuffer.push(chunk.text);
      } else {
        allCitations.push(chunk.citation);
      }
    },
    { signal: options.signal, disableTools: true },
  );

  for (const text of chunkBuffer) {
    yield { type: 'summary_chunk', runId, seq: seq++, deltaText: text };
  }

  aggregatedTokensIn += summaryStream.usage?.tokensIn ?? 0;
  aggregatedTokensOut += summaryStream.usage?.tokensOut ?? 0;
  aggregatedLlmCalls += 1; // the summary stream() call
  const summaryToolCount = Object.values(
    summaryStream.toolUseCounts ?? {},
  ).reduce((s, n) => s + n, 0);
  aggregatedToolCalls += summaryToolCount;
  // Day 11.5b: route summary-phase tools through middleware too.
  recordToolUses(summaryStream.toolUseCounts, summaryStream.usage);
  aggregatedCostUsd += computeUsd(
    summaryStream.model,
    summaryStream.usage?.tokensIn ?? 0,
    summaryStream.usage?.tokensOut ?? 0,
  );

  yield {
    type: 'cost_update',
    runId,
    seq: seq++,
    totalUsd: aggregatedCostUsd,
    totalTokens: aggregatedTokensIn + aggregatedTokensOut,
    toolCalls: aggregatedToolCalls,
  };

  // Parse with the lenient schema (sourceType/retrievedAt optional) — LLMs
  // consistently omit these on summary-stage citations because they only
  // see the summary markdown, not the original Citation records. The
  // hydrator fills missing fields from `allCitations` (matched by URL) or
  // falls back to OTHER + dataAsOf, then re-validates against the strict
  // ComprehensiveSummary. Incident: 000725.SZ / 002714.SZ (2026-05-26),
  // every COMPREHENSIVE run was failing with
  // `Structured output failed after one repair pass: …citations[].sourceType…`.
  const { fixedSummary, trace: summaryTrace } = await parseSummaryStructured(
    provider,
    summaryStream.text,
    allCitations,
    todayDate,
    options.signal,
  );
  aggregatedTokensIn += summaryTrace.tokensIn;
  aggregatedTokensOut += summaryTrace.tokensOut;
  aggregatedLlmCalls += summaryTrace.llmCalls;
  aggregatedCostUsd += summaryTrace.costUsd;

  yield {
    type: 'summary_complete',
    runId,
    seq: seq++,
    fullMarkdown: summaryStream.text,
    json: fixedSummary,
  };

  yield {
    type: 'cost_update',
    runId,
    seq: seq++,
    totalUsd: aggregatedCostUsd,
    totalTokens: aggregatedTokensIn + aggregatedTokensOut,
    toolCalls: aggregatedToolCalls,
  };

  const finalStatus: RunStatus =
    failures.length === 0 ? 'COMPLETED' : 'PARTIAL_FAILED';
  const result = buildResult({
    status: finalStatus,
    dimResults,
    failures,
    summary: { markdown: summaryStream.text, structured: fixedSummary },
    allCitations,
    allWarnings,
    aggregatedTokensIn,
    aggregatedTokensOut,
    aggregatedLlmCalls,
    aggregatedToolCalls,
    aggregatedCostUsd,
    perDimTrace,
    workflowStartedAt,
  });
  yield {
    type: 'done',
    runId,
    seq: seq++,
    status: finalStatus,
    result: toAnalysisResult(result),
  };
  return result;
}

/**
 * Convenience wrapper: drains streamComprehensive and returns the final
 * ComprehensiveResult. Use this when you don't need per-event streaming.
 */
export async function runComprehensive(
  provider: AgentProvider,
  input: DimensionInput,
  options: ComprehensiveOptions,
): Promise<ComprehensiveResult> {
  const gen = streamComprehensive(provider, input, options);
  while (true) {
    const next = await gen.next();
    if (next.done) return next.value;
  }
}
