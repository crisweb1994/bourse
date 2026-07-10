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
  /** Hard cap on cumulative estimated LLM cost in USD. */
  maxCostUsd?: number;
  /** Hard cap on cumulative tool calls. */
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
   * Execution mode.
   *
   *   - undefined (default): sequential streaming.
   *   - `'auto'`: wave execution. Dimensions group by their
   *     `wave` field (defaulting to 1). Wave-internal dims run with
   *     `waveSemaphore` concurrency; waves are gated synchronously so
   *     budget checks and fail-run halts work between waves.
   *   - `'sequential'`: explicit sequential streaming.
   */
  waveMode?: 'auto' | 'sequential';
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
   * Internal recovery switch. apps/api enables it for production runs; tests
   * leave it off when they need to exercise the no-pack path directly.
   */
  recoverMissingEvidence?: boolean;
  /**
   * Path A: a pre-built evidence pack supplied by the consumer (apps/api builds
   * it via connector → compute → snapshotToEvidencePack, merging the CN tool
   * signals). When present the workflow uses it directly and skips the internal
   * Stage-0 builder. A critically-degraded pack (neither quote nor financials)
   * still triggers market-agnostic web_search recovery when enabled.
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
