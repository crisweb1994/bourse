import { BudgetExhaustedError } from '../primitives/errors';
import type {
  ToolCacheKey,
  ToolCachePort,
  ToolContext,
  ToolDescriptor,
  ToolPolicy,
  ToolResult,
} from './types';

export interface ToolInvocationRecord {
  toolName: string;
  startedAt: number;
  durationMs: number;
  citationsCount: number;
  tokensIn: number;
  tokensOut: number;
  /** USD estimate; 0 when no pricing function provided. */
  costUsd: number;
  /** RFC-02: whether this invocation was served from cache (no upstream call). */
  cacheHit?: boolean;
  /**
   * RFC-09 P2: free-form tag propagated from ToolPolicy.traceTag, so the
   * apps/api layer can group invocations by section / run / dimension
   * when the same runner is shared across concurrent sections. Defaults
   * to `toolName` when policy omits traceTag.
   */
  traceTag?: string;
}

/** Pricing hook: per-tool token cost. */
export type PricingFn = (
  toolName: string,
  tokensIn: number,
  tokensOut: number,
) => number;

export interface ToolMiddlewareConfig {
  /** Per-tool call cap; throws BudgetExhaustedError when exceeded. */
  maxCallsPerTool?: Record<string, number>;
  /** Total tool call cap across all tools. */
  maxTotalCalls?: number;
  /** Optional cost calculator (Day 11e wires Claude pricing here). */
  pricing?: PricingFn;
  /** Optional explicit-tool result cache. Absent means cache is skipped. */
  cache?: ToolCachePort;
}

/**
 * Walking-skeleton ToolMiddleware. Tracks invocations, computes USD
 * cost (when pricing is provided), and enforces tool-call caps.
 *
 * For provider-internal tools (webSearch), call `record()` AFTER
 * provider.stream returns with the tool_use counts from finalMessage.
 * For explicit tools (Day 11+ peerLookup/etc.), wrap the run() call.
 */
export class ToolMiddlewareRunner {
  private readonly invocations: ToolInvocationRecord[] = [];
  private readonly callCounts = new Map<string, number>();

  constructor(private readonly config: ToolMiddlewareConfig = {}) {}

  /**
   * Record one tool invocation. Throws BudgetExhaustedError if caps are
   * exceeded — caller is responsible for catching and emitting an error
   * event before terminating the workflow.
   */
  record(record: Omit<ToolInvocationRecord, 'costUsd'>): void {
    const usd = this.config.pricing
      ? this.config.pricing(record.toolName, record.tokensIn, record.tokensOut)
      : 0;
    this.invocations.push({ ...record, costUsd: usd });
    this.callCounts.set(
      record.toolName,
      (this.callCounts.get(record.toolName) ?? 0) + 1,
    );

    const perToolCap = this.config.maxCallsPerTool?.[record.toolName];
    const usedForTool = this.callCounts.get(record.toolName) ?? 0;
    if (perToolCap !== undefined && usedForTool > perToolCap) {
      throw new BudgetExhaustedError(
        `Tool "${record.toolName}" exceeded maxCallsPerTool=${perToolCap}`,
        'maxToolCalls',
      );
    }
    if (
      this.config.maxTotalCalls !== undefined &&
      this.totalCalls > this.config.maxTotalCalls
    ) {
      throw new BudgetExhaustedError(
        `Tool calls exceeded maxTotalCalls=${this.config.maxTotalCalls}`,
        'maxToolCalls',
      );
    }
  }

  get totalCalls(): number {
    return this.invocations.length;
  }

  get totalCostUsd(): number {
    return this.invocations.reduce((sum, r) => sum + r.costUsd, 0);
  }

  callsFor(toolName: string): number {
    return this.callCounts.get(toolName) ?? 0;
  }

  getInvocations(): readonly ToolInvocationRecord[] {
    return this.invocations;
  }

  /**
   * RFC-02 §9: execute an explicit tool through the gateway. Adds:
   *  - cache lookup (if config.cache present and policy.cacheTtlMs > 0)
   *  - retry with backoff (policy.retries × policy.retryBackoffMs)
   *  - per-attempt timeout (policy.timeoutMs)
   *  - 429-aware retry-after handling (parsed from Error message)
   *  - cache write on success
   *  - record() telemetry (composes with existing record-keeping)
   *
   * The fallback chain (multi-source within a fact field) lives INSIDE
   * tool.run() — the gateway only knows about a single tool. This keeps
   * source-routing logic colocated with the tool that owns it.
   */
  async run<TInput extends { symbol: string; market: string }, TOutput>(
    tool: ToolDescriptor<TInput, TOutput>,
    input: TInput,
    ctx: ToolContext,
    policy: ToolPolicy = {},
  ): Promise<ToolResult<TOutput>> {
    if (!tool.run) {
      throw new Error(
        `ToolMiddlewareRunner.run: tool "${tool.name}" has no run() (provider-internal?)`,
      );
    }

    const cacheKey: ToolCacheKey = {
      toolName: tool.name,
      market: input.market,
      symbol: input.symbol,
      args: input,
    };
    const useCache =
      this.config.cache !== undefined && (policy.cacheTtlMs ?? 0) > 0;

    // RFC-09 P2: resolve traceTag once per call (default = tool.name).
    const traceTag = policy.traceTag ?? tool.name;

    // ----- Cache lookup -----
    if (useCache && this.config.cache) {
      try {
        const cached = await this.config.cache.get(cacheKey);
        if (cached !== null && cached !== undefined) {
          const result = cached as ToolResult<TOutput>;
          // Mark as cache hit; record() so per-tool counts include hits.
          this.record({
            toolName: tool.name,
            startedAt: Date.now(),
            durationMs: 0,
            citationsCount: result.citations?.length ?? 0,
            tokensIn: result.cost?.tokensIn ?? 0,
            tokensOut: result.cost?.tokensOut ?? 0,
            cacheHit: true,
            traceTag,
          });
          return {
            ...result,
            trace: { ...(result.trace ?? {}), cacheHit: true },
          };
        }
      } catch {
        // Cache read failure must not block execution; treat as miss.
      }
    }

    // ----- Execute with retry + timeout -----
    const retries = policy.retries ?? 2;
    const backoff = policy.retryBackoffMs ?? [500, 1500];
    const timeoutMs = policy.timeoutMs ?? 15000;

    let lastError: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      const startedAt = Date.now();
      try {
        const result = await withTimeout(tool.run(input, ctx), timeoutMs);
        const durationMs = Date.now() - startedAt;

        // ----- Cache write -----
        if (useCache && this.config.cache && policy.cacheTtlMs) {
          try {
            await this.config.cache.set(cacheKey, result, policy.cacheTtlMs);
          } catch {
            // Cache write failure swallowed; tool succeeded, return value.
          }
        }

        this.record({
          toolName: tool.name,
          startedAt,
          durationMs,
          citationsCount: result.citations.length,
          tokensIn: result.cost.tokensIn,
          tokensOut: result.cost.tokensOut,
          cacheHit: false,
          traceTag,
        });

        // RFC-09 P2: per-call USD ceiling — fire AFTER pricing computes
        // the latest invocation's cost. This stays additive (tools that
        // don't set budgetCapUsd are unaffected).
        if (policy.budgetCapUsd !== undefined) {
          const lastRecord =
            this.invocations[this.invocations.length - 1];
          if (lastRecord && lastRecord.costUsd > policy.budgetCapUsd) {
            throw new BudgetExhaustedError(
              `Tool "${tool.name}" cost $${lastRecord.costUsd.toFixed(4)} ` +
                `exceeded budgetCapUsd=$${policy.budgetCapUsd}`,
              'toolBudget',
            );
          }
        }

        return {
          ...result,
          trace: {
            ...(result.trace ?? {}),
            durationMs: result.trace?.durationMs ?? durationMs,
            cacheHit: false,
          },
        };
      } catch (err) {
        // RFC-09 P2: BudgetExhaustedError surfaces from the post-record
        // budget check, AFTER tool.run succeeded — retrying would just
        // burn more spend. Escape the retry loop immediately.
        if (err instanceof BudgetExhaustedError) throw err;
        lastError = err;
        if (attempt >= retries) break;
        const retryAfterMs = extractRetryAfterMs(err);
        const backoffMs =
          retryAfterMs ??
          backoff[attempt] ??
          backoff[backoff.length - 1] ??
          1000;
        await sleep(backoffMs);
      }
    }

    throw lastError;
  }
}

// ===== Helpers =====

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Tool timeout after ${ms}ms`)),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Parse a retry-after hint from the error message. Tool adapters that
 * surface HTTP 429s should embed "retry-after: NNN" (seconds) in the
 * thrown Error.message; gateway uses that as the next sleep duration
 * instead of the default backoff. Returns ms or undefined.
 *
 * Hotfix (2026-05-15): cap at 5s. Upstream WAF (tencent / eastmoney /
 * cninfo) lies — many return 429 with no real cooldown signal and our
 * tool adapters hardcode "retry-after: 30" as a fixed string. Honoring
 * that literally lets a single anti-scrape episode stall Stage 0 for
 * minutes (3 attempts × 30s × 4 serial tools ≈ 4-9 min). The shorter
 * cap means we still back off but recover fast; the real fix for the
 * 429 source itself is browser-style UA on the fetch (see tools/cn/_).
 */
const MAX_RETRY_AFTER_MS = 5000;

function extractRetryAfterMs(err: unknown): number | undefined {
  if (!(err instanceof Error)) return undefined;
  const m = err.message.match(/retry[- ]after[:\s]+(\d+)/i);
  if (!m) return undefined;
  const seconds = parseInt(m[1], 10);
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
