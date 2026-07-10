import type { ZodSchema } from 'zod';
import type { StructuredJson } from '../contracts/analysis-result';
import type { Citation } from '../contracts/citation';
import type { Confidence, SectionType, Signal } from '../contracts/enums';

// Day 4 only knows about webSearch. Day 6+ will add peerLookup /
// financialSnapshot / newsScan as the V1+ tool pack lands.
export const TOOL_NAMES = ['webSearch'] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

export interface FreshnessPolicy {
  pricesMaxAgeDays: number;
  newsMaxAgeDays: number;
  /** e.g., '使用最近一份已公布的季报或年报' */
  financialsRequirement: string;
  /** e.g., '6 个月前或更早' */
  staleDataWarningThreshold: string;
  /** Optional: industry report freshness (used by INDUSTRY dim later) */
  industryReportMaxAgeDays?: number;
}

export interface DimensionInput {
  symbol: string;
  market: string;
  /** Display name; falls back to symbol when omitted */
  name?: string;
  locale: string;
}

export interface DimensionRunContext {
  /** YYYY-MM-DD, injected by the runner so prompts share a single "today". */
  todayDate: string;
}

export interface BuiltPrompts {
  system: string;
  user: string;
}

export interface DimensionRunResult<T extends StructuredJson = StructuredJson> {
  type: SectionType;
  reportMarkdown: string;
  structuredJson: T;
  citations: Citation[];
  signal: Signal;
  confidence: Confidence;
  /** 0-100 score, derived by `Dimension.score()` */
  score: number;
  status: 'COMPLETED' | 'FAILED';
  /** Soft warnings (e.g., citation policy violations); does not fail the run. */
  warnings: string[];
  usage: { tokensIn: number; tokensOut: number };
}

/**
 * MVP doc §3.1 + §4.2.1: optional dim-internal multi-turn tool-use plan.
 * When present, the dim runner builds N-1 follow-up rounds and passes them
 * to provider.stream() via ProviderStreamOptions.rounds. All values are
 * code-side constants — the LLM never decides "let me run another round".
 *
 * Naming: `maxRounds = 2` means "Round 1 (initial buildPrompts.user) +
 * 1 extra (roundPrompts[0])". `roundPrompts.length` MUST equal
 * `maxRounds - 1`; registry enforces this with InvalidContractError.
 */
export interface MultiRoundPlan {
  /** Total rounds including the initial Round 1. Must be 2 or 3. */
  maxRounds: 2 | 3;
  /**
   * User prompt builders for Round 2..N. Length must equal `maxRounds - 1`.
   * Round 1's user prompt comes from `Dimension.buildPrompts(input).user`.
   */
  roundPrompts: ReadonlyArray<
    (input: DimensionInput, ctx: DimensionRunContext) => string
  >;
  /** Per-round web_search invocation cap. Defaults to 4. */
  perRoundToolUses?: number;
}

/**
 * Strong-contract dimension definition. 9 required fields + 1 optional
 * (`multiRoundPlan`) — see CLAUDE.md §3 #18 / MVP doc §3.1.
 */
export interface Dimension<T extends StructuredJson = StructuredJson> {
  type: SectionType;
  inputSchema: ZodSchema<DimensionInput>;
  buildPrompts(input: DimensionInput, ctx: DimensionRunContext): BuiltPrompts;
  allowedTools: readonly ToolName[];
  outputSchema: ZodSchema<T>;
  freshness: FreshnessPolicy;
  score(result: T): number;
  onFailure: 'skip' | 'retry-once' | 'fail-run';
  /** Plan 3 §4.3.5: optional multi-round agentic plan. */
  multiRoundPlan?: MultiRoundPlan;
  /**
   * RFC-05: which wave this dim belongs to (1-3). Same-wave dims run
   * concurrently under `waveSemaphore`; later waves wait for earlier
   * waves to fully settle. Default 1 (single-wave = current
   * `parallel: true` behavior). Higher wave numbers are reserved for
   * RFC-06+ cross-dim composition (dims that read prior-wave outputs);
   * RFC-05 only ships the executor scaffolding.
   */
  wave?: 1 | 2 | 3;

  /**
   * RFC-10: when the COMPREHENSIVE selective-judge phase should audit
   * this dim's output. Default `'on-strong'`. The workflow OR-combines
   * this with global rules (Tier D/E citation ratio threshold, cross-dim
   * validator WARNING/DOWNGRADE on this dim) — see `shouldJudge` in
   * `primitives/judge.ts`.
   *
   *   'always'    — every COMPLETED run goes through judge (use for
   *                 high-stakes dims like VALUATION / RISK / SCENARIO).
   *   'on-strong' — only HIGH confidence + BULLISH/BEARISH signal
   *                 triggers (default; neutral outputs are skipped).
   *   'never'     — judge skipped regardless of other rules (use for
   *                 low-stakes dims like TECHNICAL / SENTIMENT where
   *                 audit cost outweighs benefit).
   */
  judgeRequired?: 'always' | 'on-strong' | 'never';

  /**
   * RFC rfc-evidence-pack-web-search-fallback §2.4: A-share private-data
   * fields this dim relies on. When the EvidencePack is degraded
   * (web_search fallback) AND any listed field is in the pack's
   * `missingPrivateFields`, the workflow SKIPs this dim instead of
   * running it on incomplete data — preventing the LLM from fabricating
   * 北向 / 龙虎榜 / 解禁 / 一致预期 numbers from generic search snippets.
   *
   * Initial mapping (RFC §2.4 草案):
   *   SENTIMENT  → ['northboundFlow', 'lhb']
   *   GOVERNANCE → ['unlockCalendar']
   *   VALUATION  → ['consensusEps']
   * Other dims do not require A-share private data and remain runnable
   * in degraded mode (with reduced precision).
   */
  requiresPrivateData?: ReadonlyArray<
    'northboundFlow' | 'lhb' | 'unlockCalendar' | 'consensusEps'
  >;
}
