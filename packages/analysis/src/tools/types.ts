import type { ZodSchema } from 'zod';
import type { Citation } from '../contracts/citation';
import type { MarketProfile } from '../markets/types';

/**
 * RFC-02: ToolResult.trace — populated by ToolMiddlewareRunner.run when
 * a tool successfully returns. Tools can also fill `source` and
 * `fallbacksTriggered` themselves to describe internal multi-source
 * walks (e.g. quoteSnapshot trying tencent → eastmoney).
 */
export interface ToolTrace {
  /** Which source the tool's run() ultimately succeeded against. */
  source?: string;
  /** Wall-clock ms inside tool.run() (excludes gateway retry/cache). */
  durationMs?: number;
  /** Count of within-tool fallback hops (0 = primary source worked). */
  fallbacksTriggered?: number;
  /** Whether the gateway served this from cache instead of running tool. */
  cacheHit?: boolean;
}

/** Three-tuple result from explicit tool invocations (CLAUDE.md §3 #16). */
export interface ToolResult<T = unknown> {
  data: T;
  citations: Citation[];
  cost: {
    tokensIn: number;
    tokensOut: number;
    usdEstimate?: number;
  };
  /** RFC-02: optional per-run trace. Gateway adds cacheHit. */
  trace?: ToolTrace;
}

export interface ToolContext {
  signal?: AbortSignal;
  /**
   * RFC-02: market profile available to the tool for fallback-chain
   * routing (tool reads ctx.marketProfile.sourcePriorities[factField]
   * to know which sources to try in order).
   * Optional for back-compat with existing provider-internal tools.
   */
  marketProfile?: MarketProfile;
}

/**
 * Tool descriptor. Two flavors:
 *
 *   - **Explicit tools** (run defined): code invokes them directly,
 *     middleware can pre-validate input, run, post-process.
 *     Walking-skeleton has none yet (peerLookup/financialSnapshot/
 *     newsScan land in V1+).
 *
 *   - **Provider-internal tools** (providerInternal=true, no run):
 *     invoked server-side by the LLM provider (e.g. Anthropic
 *     web_search). Middleware can only observe them post-hoc by
 *     reading provider.stream's `toolUseCounts` and apply caps via
 *     `maxToolUses` option on the next stream call.
 */
export interface ToolDescriptor<TInput = unknown, TOutput = unknown> {
  name: string;
  description: string;
  providerInternal: boolean;
  inputSchema?: ZodSchema<TInput>;
  /**
   * RFC-02: explicit-tool fields. Optional so existing webSearch
   * descriptor (provider-internal) doesn't need to populate them.
   */
  market?: string;          // 'CN' / 'US' / 'HK' / 'JP' / 'UK'
  factField?: string;        // EvidencePackV2 fact key (e.g. 'quote')
  outputSchema?: ZodSchema<TOutput>;
  run?: (input: TInput, ctx: ToolContext) => Promise<ToolResult<TOutput>>;
}

/**
 * RFC-02 §9: per-call policy for ToolMiddlewareRunner.run.
 * All fields optional; sensible defaults applied at runtime.
 */
export interface ToolPolicy {
  /** Retry count after first attempt. Default 2 (= 3 total tries). */
  retries?: number;
  /** Backoff between retries in ms. Default [500, 1500]. */
  retryBackoffMs?: number[];
  /** Hard timeout per attempt. Default 15000. */
  timeoutMs?: number;
  /** Cache TTL in ms. 0 / undefined → skip cache entirely. */
  cacheTtlMs?: number;

  /**
   * RFC-09 P1: per-tool-call USD ceiling. When the just-computed cost
   * (post-run, post-pricing) exceeds this value, the gateway throws
   * BudgetExhaustedError('toolBudget'). Undefined → no per-call check.
   * Aggregate budget is enforced separately by ToolMiddlewareConfig
   * (maxCallsPerTool / maxTotalCalls). RFC-09 P2 wires the check inside
   * `ToolMiddlewareRunner.run`; this field is inert until then.
   */
  budgetCapUsd?: number;

  /**
   * RFC-09 P1: free-form tag attached to ToolInvocationRecord so apps/api
   * can group invocations by section / run / dimension when the same
   * runner is shared across concurrent sections (DAG wave). Defaults to
   * `tool.name` when omitted. RFC-09 P2 wires the propagation; field is
   * inert until then.
   */
  traceTag?: string;
}

/**
 * RFC-02 §10: cache port the apps layer implements (e.g.
 * apps/api ToolCacheService). packages/agent declares the shape
 * here so it stays decoupled from @prisma/client.
 */
export interface ToolCacheKey {
  toolName: string;
  market: string;
  symbol: string;
  args?: unknown;
}

export interface ToolCachePort {
  get(key: ToolCacheKey): Promise<unknown | null>;
  set(key: ToolCacheKey, payload: unknown, ttlMs: number): Promise<void>;
}
