import type { Citation } from '../../contracts/citation';
import { resultsToCitations, resultsToToolMessageJson } from './normalize';
import {
  SearchQuery,
  type SearchResults,
  type WebSearchAdapter,
  type WebSearchToolOutput,
} from './types';

/**
 * Runtime gateway in front of a `WebSearchAdapter`. Responsibilities:
 *   - per-run LRU cache (default 5min) to dedupe repeated queries from the
 *     same model+section run
 *   - aggregate USD budget cap across all calls in this executor's lifetime
 *   - per-call retry (one retry on transient error)
 *   - normalize adapter output → tool message JSON + Citation[]
 *
 * Lifetime: one executor per dimension run. The provider instantiates a
 * fresh executor on each `stream()` call so cache+budget don't leak
 * across runs.
 */

/**
 * RFC rfc-web-search-backend-config §2.4: optional post-search filter
 * that drops results whose host falls below a minimum domain tier. Host
 * lookup is case-insensitive on the URL's hostname. Hosts not present in
 * the table are treated as tier `C` by default (neutral — neither
 * preferred nor blocked).
 */
export interface DomainTierFilterConfig {
  tiers: Record<string, 'A' | 'B' | 'C' | 'D' | 'E'>;
  /** Hosts with tier strictly below this are dropped. Default 'D'
   *  (i.e. only E is dropped). Set to 'C' for stricter filtering. */
  dropBelow?: 'D' | 'C';
}

export interface WebSearchExecutorConfig {
  adapter: WebSearchAdapter;
  /** Per-search hard timeout. */
  timeoutMs: number;
  /** Soft cap across all calls in this executor. */
  budgetUsdPerRun: number;
  /** Per-run cache TTL. */
  cacheTtlMs: number;
  /** Cache capacity, default 64. Set to 0 to disable cache. */
  cacheMaxEntries?: number;
  /** RFC rfc-web-search-backend-config §2.4: see DomainTierFilterConfig. */
  domainTierFilter?: DomainTierFilterConfig;
  /** Test seam. */
  now?: () => number;
}

export interface ExecuteResult {
  output: WebSearchToolOutput;
  budgetExhausted: boolean;
  error?: { code: string; message: string };
}

interface CacheEntry {
  expiresAt: number;
  results: SearchResults;
}

export class BudgetExhaustedError extends Error {
  constructor(public readonly spentUsd: number, public readonly capUsd: number) {
    super(
      `web-search budget exhausted: spent $${spentUsd.toFixed(4)} of $${capUsd.toFixed(4)}`,
    );
    this.name = 'BudgetExhaustedError';
  }
}

export class WebSearchExecutor {
  readonly providerId: string;
  private spentUsd = 0;
  private callCount = 0;
  private cacheHits = 0;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly retrievedAtIso: string;

  constructor(private readonly cfg: WebSearchExecutorConfig) {
    this.providerId = cfg.adapter.name;
    this.retrievedAtIso = new Date().toISOString();
  }

  /** Telemetry snapshot. */
  stats(): {
    providerId: string;
    callCount: number;
    cacheHits: number;
    spentUsd: number;
  } {
    return {
      providerId: this.providerId,
      callCount: this.callCount,
      cacheHits: this.cacheHits,
      spentUsd: this.spentUsd,
    };
  }

  /**
   * Run one search. Throws BudgetExhaustedError when over cap; surfaces
   * adapter errors as `result.error` (caller decides how to feed back to
   * the LLM — typically a tool message saying "search failed").
   */
  async execute(
    raw: { query: string; freshnessDays?: number; count?: number },
    signal?: AbortSignal,
  ): Promise<ExecuteResult> {
    if (this.spentUsd >= this.cfg.budgetUsdPerRun) {
      throw new BudgetExhaustedError(this.spentUsd, this.cfg.budgetUsdPerRun);
    }

    const query = SearchQuery.parse({
      query: raw.query,
      freshnessDays: raw.freshnessDays,
      count: raw.count ?? 8,
    });

    const key = cacheKey(this.providerId, query.query, query.freshnessDays);
    const cached = this.readCache(key);
    if (cached) {
      this.cacheHits += 1;
      return { output: this.materialize(cached), budgetExhausted: false };
    }

    let lastErr: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const results = await this.cfg.adapter.search(query, {
          signal,
          timeoutMs: this.cfg.timeoutMs,
        });
        this.callCount += 1;
        this.spentUsd += results.costUsd;
        this.writeCache(key, results);
        return {
          output: this.materialize(results),
          budgetExhausted: this.spentUsd >= this.cfg.budgetUsdPerRun,
        };
      } catch (err) {
        lastErr = err;
        if (attempt === 0 && isRetryable(err)) {
          await delay(400);
          continue;
        }
        break;
      }
    }

    const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
    const empty: SearchResults = {
      query: query.query,
      items: [],
      provider: this.cfg.adapter.name,
      costUsd: 0,
      durationMs: 0,
      cached: false,
    };
    return {
      output: this.materialize(empty),
      budgetExhausted: false,
      error: { code: 'search_failed', message: msg },
    };
  }

  private materialize(results: SearchResults): WebSearchToolOutput {
    const filtered = this.applyDomainTierFilter(results);
    const citations: Citation[] = resultsToCitations(
      filtered,
      this.retrievedAtIso,
    );
    const text = resultsToToolMessageJson(filtered);
    return { text, citations, results: filtered };
  }

  /**
   * RFC rfc-web-search-backend-config §2.4: drop results whose host falls
   * below `dropBelow` tier. Pure post-filter — adapter behavior unchanged.
   */
  private applyDomainTierFilter(results: SearchResults): SearchResults {
    const cfg = this.cfg.domainTierFilter;
    if (!cfg) return results;
    const rank: Record<string, number> = { A: 5, B: 4, C: 3, D: 2, E: 1 };
    const threshold = rank[cfg.dropBelow ?? 'D'];
    const kept = results.items.filter((item) => {
      try {
        const host = new URL(item.url).hostname.toLowerCase();
        const tier = cfg.tiers[host] ?? 'C';
        return rank[tier] >= threshold;
      } catch {
        return true; // malformed URL: keep, let downstream guard handle
      }
    });
    return { ...results, items: kept };
  }

  private readCache(key: string): SearchResults | null {
    if (!this.cfg.cacheTtlMs) return null;
    const e = this.cache.get(key);
    if (!e) return null;
    const now = (this.cfg.now ?? Date.now)();
    if (e.expiresAt <= now) {
      this.cache.delete(key);
      return null;
    }
    return { ...e.results, cached: true };
  }

  private writeCache(key: string, results: SearchResults): void {
    if (!this.cfg.cacheTtlMs) return;
    const capacity = this.cfg.cacheMaxEntries ?? 64;
    if (this.cache.size >= capacity) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) this.cache.delete(firstKey);
    }
    const now = (this.cfg.now ?? Date.now)();
    this.cache.set(key, {
      expiresAt: now + this.cfg.cacheTtlMs,
      results,
    });
  }
}

function cacheKey(provider: string, query: string, freshnessDays?: number): string {
  return `${provider}::${query.trim().toLowerCase()}::${freshnessDays ?? ''}`;
}

function isRetryable(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const m = err.message.toLowerCase();
  // Timeouts, 429, 5xx
  return (
    m.includes('timeout') ||
    m.includes('http 429') ||
    m.includes('http 5') ||
    m.includes('econnreset') ||
    m.includes('fetch failed')
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
