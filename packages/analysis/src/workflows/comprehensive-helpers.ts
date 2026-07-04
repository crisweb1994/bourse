/**
 * Comprehensive workflow 的纯函数 helpers + 内部类型。
 *
 * refactor-v1 Wave 4：从 `comprehensive.ts` (1447 LOC) 抽出 ~210 LOC 纯函数。
 * 主文件 `comprehensive.ts` 保留 streamComprehensive async generator + 各 phase
 * 之间共享 state；本文件存"输入 → 输出无副作用"helpers，让两边都更易读。
 */
import type { AnalysisResult } from '../contracts/analysis-result';
import type { Citation } from '../contracts/citation';
import type { AnalysisType, RunStatus } from '../contracts/enums';
import type { SseEvent } from '../contracts/sse-events';
import type { Dimension, DimensionRunResult } from '../dimensions/types';
import type { BudgetLimits } from './types';
import type {
  ComprehensiveResult,
  DimensionFailure,
} from './types';

/**
 * Per-dimension state accumulated from SSE events while a single dimension
 * is streaming. Populated by `accumulate()` as events arrive, then handed
 * to `finalizeDim()` to be turned into a `DimensionRunResult`.
 */
export interface DimAccumulator {
  markdown: string;
  json: unknown;
  citations: Citation[];
  usage: { tokensIn: number; tokensOut: number };
  llmCalls: number;
  toolCalls: number;
  durationMs: number;
  citationsCount: number;
  costUsd: number;
}

/**
 * Apply a judge's confidenceAdjustment to the dim's structuredJson +
 * top-level confidence. Mutation is in-place since `dimResults` is the
 * canonical store the summary phase reads from. Only DOWNGRADE_* values
 * mutate; KEEP is a no-op (JudgeResult schema guarantees no UPGRADE).
 */
export function applyConfidenceDowngrade(
  dimResults: Map<AnalysisType, DimensionRunResult>,
  type: AnalysisType,
  adjustment: 'KEEP' | 'DOWNGRADE_TO_MEDIUM' | 'DOWNGRADE_TO_LOW',
): void {
  if (adjustment === 'KEEP') return;
  const target = adjustment === 'DOWNGRADE_TO_LOW' ? 'LOW' : 'MEDIUM';
  const dim = dimResults.get(type);
  if (!dim) return;
  // Don't fight an already-lower confidence; DOWNGRADE_TO_MEDIUM on a LOW
  // dim must stay LOW (we can only move DOWN, never UP).
  const rank: Record<string, number> = { HIGH: 3, MEDIUM: 2, LOW: 1 };
  const currentRank = rank[dim.confidence] ?? 3;
  const targetRank = rank[target] ?? 2;
  if (targetRank >= currentRank) return;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (dim as any).confidence = target;
  const sj = dim.structuredJson as { conclusion?: { confidence?: string } };
  if (sj && sj.conclusion) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (sj.conclusion as any).confidence = target;
  }
}

/**
 * Fold a single SSE event into the per-dim accumulator. Returns nothing —
 * the accumulator is mutated in place (it lives one-per-dim inside the
 * main wave loop).
 */
export function accumulate(event: SseEvent, acc: DimAccumulator): void {
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
        acc.citationsCount = event.usage.citationsCount ?? acc.citations.length;
        acc.costUsd = event.usage.costUsd ?? 0;
      }
      break;
  }
}

/**
 * Validate the accumulated structured JSON against the dim's schema and
 * project to the canonical `DimensionRunResult`. Throws when the JSON
 * doesn't satisfy the schema — caller treats as dim-failure.
 *
 * Note: `stream-dimension` already throws on enforced citation violation,
 * so reaching here means policy passed (or was non-enforced).
 */
export function finalizeDim(
  dim: Dimension,
  acc: DimAccumulator,
): DimensionRunResult {
  const parsed = dim.outputSchema.safeParse(acc.json);
  if (!parsed.success) {
    throw new Error(
      `streamDimension structured_data did not satisfy outputSchema: ${parsed.error.message}`,
    );
  }
  const score = dim.score(parsed.data);
  return {
    type: dim.type,
    reportMarkdown: acc.markdown,
    structuredJson: parsed.data,
    citations: acc.citations,
    signal: parsed.data.conclusion.signal,
    confidence: parsed.data.conclusion.confidence,
    score,
    status: 'COMPLETED',
    warnings: [],
    usage: acc.usage,
  };
}

export interface BuildResultArgs {
  status: RunStatus;
  dimResults: Map<AnalysisType, DimensionRunResult>;
  failures: DimensionFailure[];
  /**
   * Dimensions skipped because the workflow halted (e.g., budget
   * exhausted). Merged with `failures` types into result.partialDimensions.
   */
  unrunDimensions?: AnalysisType[];
  summary: ComprehensiveResult['summary'];
  allCitations: Citation[];
  allWarnings: string[];
  aggregatedTokensIn: number;
  aggregatedTokensOut: number;
  aggregatedLlmCalls: number;
  aggregatedToolCalls: number;
  aggregatedCostUsd: number;
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
  workflowStartedAt: number;
}

/**
 * Assemble the workflow-level `ComprehensiveResult` from per-dim results +
 * summary + aggregated trace. Pure; no SSE side effects.
 */
export function buildResult(args: BuildResultArgs): ComprehensiveResult {
  const perDimension =
    args.perDimTrace.size > 0
      ? (Object.fromEntries(args.perDimTrace) as Record<
          AnalysisType,
          {
            durationMs: number;
            citationsCount: number;
            tokensIn: number;
            tokensOut: number;
            llmCalls: number;
            toolCalls: number;
          }
        >)
      : undefined;
  // Merge explicit failures with un-run dims (budget exhaustion case).
  const partialDimensions = [
    ...args.failures.map((f) => f.type),
    ...(args.unrunDimensions ?? []),
  ];
  return {
    status: args.status,
    perDimension: args.dimResults,
    failures: args.failures,
    partialDimensions,
    summary: args.summary,
    citations: args.allCitations,
    warnings: args.allWarnings,
    trace: {
      llmCalls: args.aggregatedLlmCalls,
      toolCalls: args.aggregatedToolCalls,
      tokensIn: args.aggregatedTokensIn,
      tokensOut: args.aggregatedTokensOut,
      totalUsd: args.aggregatedCostUsd,
      durationMs: Date.now() - args.workflowStartedAt,
      perDimension,
    },
  };
}

/**
 * Project the workflow-level ComprehensiveResult onto the wire-format
 * AnalysisResult that the `done` SSE event carries (MVP doc §1.1).
 *
 * - `structuredJson` ← summary.structured (or null when no summary stage)
 * - `reportMarkdown` ← summary.markdown (or '' when no summary)
 * - `signal` / `confidence` derived from summary; default to NEUTRAL/LOW
 *   for failed/budget-exhausted runs without a summary
 */
export function toAnalysisResult(result: ComprehensiveResult): AnalysisResult {
  const summary = result.summary;
  return {
    reportMarkdown: summary?.markdown ?? '',
    structuredJson: summary?.structured ?? null,
    citations: result.citations,
    status: result.status,
    signal: summary?.structured.overallSignal ?? 'NEUTRAL',
    confidence: summary?.structured.overallConfidence ?? 'LOW',
    trace: result.trace,
    warnings: result.warnings,
    partialDimensions:
      result.partialDimensions.length > 0
        ? result.partialDimensions
        : undefined,
  };
}

/**
 * RFC rfc-evidence-pack-web-search-fallback §2.2: classify which private-
 * data fact keys are missing based on which fallback tools failed. Used to
 * skip dimensions that explicitly require those private fields.
 */
export function inferMissingPrivateFieldsComp(
  failedTools: string[],
): Array<'northboundFlow' | 'lhb' | 'unlockCalendar' | 'consensusEps'> {
  if (failedTools.length === 0) {
    return ['northboundFlow', 'lhb', 'unlockCalendar', 'consensusEps'];
  }
  const out = new Set<
    'northboundFlow' | 'lhb' | 'unlockCalendar' | 'consensusEps'
  >();
  for (const t of failedTools) {
    if (t.includes('northbound')) out.add('northboundFlow');
    if (t.includes('lhb')) out.add('lhb');
    if (t.includes('unlock')) out.add('unlockCalendar');
    if (t.includes('consensusEps') || t.includes('consensus')) {
      out.add('consensusEps');
    }
  }
  return Array.from(out);
}

/**
 * Detect whether the run has exhausted any configured budget cap. Shared by
 * `streamSingle` and `streamComprehensive` (previously two near-identical
 * copies — `workflows/single.ts` and the `overBudget` closure in
 * `comprehensive.ts`).
 *
 * Comparison semantics differ between the two callers and are preserved
 * exactly via `inclusive`:
 *  - `inclusive: false` (single.ts) → trips when usage STRICTLY EXCEEDS the
 *    cap (`used.x > cap`). Used because single.ts checks AFTER a dim runs.
 *  - `inclusive: true` (comprehensive.ts) → trips when usage REACHES the cap
 *    (`used.x >= cap`). Used because comprehensive checks BEFORE the next dim
 *    starts, so hitting the cap exactly must halt.
 *
 * Returns the first breached cap label (tokens → cost → toolCalls order), or
 * `false` when no cap is configured or none is breached.
 */
export function checkBudget(
  budget: BudgetLimits | undefined,
  used: {
    tokens: number;
    costUsd: number;
    toolCalls: number;
  },
  inclusive: boolean,
): false | 'maxTokens' | 'maxCostUsd' | 'maxToolCalls' {
  if (!budget) return false;
  const hit = (cap: number | undefined, value: number): boolean =>
    cap !== undefined && (inclusive ? value >= cap : value > cap);
  if (hit(budget.maxTokens, used.tokens)) return 'maxTokens';
  if (hit(budget.maxCostUsd, used.costUsd)) return 'maxCostUsd';
  if (hit(budget.maxToolCalls, used.toolCalls)) return 'maxToolCalls';
  return false;
}
