import type { Citation } from '../contracts/citation';
import type { ComprehensiveSummary } from '../contracts/comprehensive-summary';
import type { RunStatus, SectionType } from '../contracts/enums';
import type { EvidencePackAny } from '../contracts/evidence-pack';
import type { Trace } from '../contracts/trace';
import type { Dimension, DimensionInput, DimensionRunResult } from '../dimensions/types';
import type { MarketProfile } from '../markets/types';
import type { AgentProvider } from '../primitives/provider';

export interface BudgetLimits {
  /** Hard cap on cumulative LLM tokens (input+output). */
  maxTokens?: number;
  /**
   * Reserved — requires per-model pricing table. Currently parsed but
   * not enforced; cost_update events emit `totalUsd: 0` until V1+.
   */
  maxCostUsd?: number;
  /**
   * Reserved — requires ToolMiddleware to count tool calls. Currently
   * parsed but not enforced; cost_update events emit `toolCalls: 0`.
   */
  maxToolCalls?: number;
}

export interface ComprehensiveOptions {
  /** Required: stable run id propagated on every SseEvent. */
  runId: string;
  /** Starting seq number; defaults to 0. */
  startSeq?: number;
  /** YYYY-MM-DD; defaults to today (UTC). */
  todayDate?: string;
  signal?: AbortSignal;
  /** Override the default 8-dimension set (mostly for tests). */
  dimensions?: readonly Dimension[];
  /**
   * Per-run cost limits. Hitting any populated cap halts the run with
   * status = BUDGET_EXHAUSTED; partial dimensions completed so far stay
   * in the result.
   */
  budget?: BudgetLimits;
  /**
   * When true, run dimensions concurrently (Promise.all on their LLM
   * calls). Events are still drained in dim order after all complete —
   * realtime interleaved streaming with monotonic seq is V1+. In
   * parallel mode, between-dim budget checks are disabled and
   * `fail-run` is downgraded to `skip` (semantic limitation: parallel
   * dims can't synchronously halt the others).
   *
   * RFC-05: still supported as a legacy shortcut. `parallel: true`
   * with budget / fail-run dims continues to throw; callers who want
   * budget-aware concurrency must opt in via `waveMode: 'auto'`.
   */
  parallel?: boolean;
  /**
   * RFC-05: wave-based execution mode.
   *
   *   - undefined (default): legacy behavior — `parallel` controls the
   *     path. `parallel: true` → all-or-nothing Promise.all (with the
   *     existing budget/fail-run rejection). `parallel: false` or
   *     undefined → sequential for-loop.
   *   - `'auto'`: opt-in wave execution. Dimensions group by their
   *     `wave` field (defaulting to 1). Wave-internal dims run with
   *     `waveSemaphore` concurrency; waves are gated synchronously so
   *     budget checks and fail-run halts work between waves.
   *   - `'disabled'` / `'sequential'`: explicit single-thread loop;
   *     equivalent to legacy `parallel: false`.
   *
   * When both `parallel` and `waveMode` are set, `waveMode` wins.
   */
  waveMode?: 'auto' | 'disabled' | 'sequential';
  /**
   * RFC-05: per-wave concurrency cap. Only meaningful when
   * `waveMode === 'auto'`. Default 4 — matches the apps/api
   * `ANALYSIS_PARALLEL_CONCURRENCY` default so behavior parity holds.
   */
  waveSemaphore?: number;
  /**
   * RFC-02 §7: market profile for routing (sourcePriorities / domainTiers
   * / endpoints) + cross-dim validator. When omitted, the cross-dim
   * validator + selective judge phase are skipped.
   */
  marketProfile?: MarketProfile;
  /**
   * RFC rfc-evidence-pack-web-search-fallback: when v2 builder fails on
   * hard (AUTH / NETWORK / RATE_LIMIT_HARD) errors, fall back to v1 LLM
   * web_search builder so the workflow can complete instead of FAILED.
   * Default false; user must opt in via AI Settings. Transient and
   * INPUT_INVALID errors never trigger fallback regardless.
   */
  allowWebSearchFallback?: boolean;
  /**
   * RFC rfc-web-search-backend-config: optional separate provider used
   * by the v1 web_search fallback path. When set, the v1 builder runs
   * against this provider (typically wired with the user's "fallback"
   * web_search adapter — e.g. self-hosted SearXNG). When unset, falls
   * back to the positional `provider`, preserving current behavior.
   */
  fallbackProvider?: AgentProvider;
  /**
   * Path A: a pre-built evidence pack supplied by the consumer (apps/api builds
   * it via connector → compute → snapshotToEvidencePack, merging the CN tool
   * signals). When present the workflow uses it directly and skips the internal
   * Stage-0 builder. A critically-degraded pack (missing BOTH quote and
   * financials) still triggers the market-agnostic web_search fallback below
   * when `allowWebSearchFallback` is set.
   */
  evidencePack?: EvidencePackAny;
}

export interface DimensionFailure {
  type: SectionType;
  error: string;
}

/**
 * Final result of streamComprehensive / runComprehensive.
 *
 * `status` ladder:
 *   - COMPLETED       — all dimensions succeeded, summary generated
 *   - PARTIAL_FAILED  — at least one dimension failed (skip), summary still
 *                       generated from the surviving dimensions
 *   - FAILED          — fail-run dimension failed OR no dimensions survived
 */
export interface ComprehensiveResult {
  status: RunStatus;
  perDimension: Map<SectionType, DimensionRunResult>;
  failures: DimensionFailure[];
  partialDimensions: SectionType[];
  /**
   * `null` when status === 'FAILED' before summary stage could run.
   */
  summary: {
    markdown: string;
    structured: ComprehensiveSummary;
  } | null;
  /** Aggregated across all dimensions + summary stream. */
  citations: Citation[];
  /** Soft warnings collected from per-dimension citation policy checks. */
  warnings: string[];
  trace: Trace;
}

/**
 * Convenience type re-export so callers can `import { Dimension } from
 * '@bourse/analysis'` and pass into ComprehensiveOptions.dimensions.
 */
export type { Dimension, DimensionInput };

// plan-v2 Wave 3.2 — debate workflow types removed (DebateInput / DebateOptions
// / DebateRoleTrace / DebateWorkflowResult). See plan-v2 §1.3 + §17.4.
