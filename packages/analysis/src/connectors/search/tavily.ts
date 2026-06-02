/**
 * Phase 5 follow-up — research-core SearchPort backed by Tavily.
 *
 * Tavily is the cleanest match for direct-mode MCP (single API key,
 * JSON in/out, generous free tier for personal use, no CAPTCHA fight).
 * Off until `apiKey` supplied — absent key surfaces AUTH_REQUIRED so the
 * MCP direct-mode `search_web` tool finally has a real backend without
 * forcing rest mode.
 */
import { RESEARCH_SCHEMA_VERSION, type ResearchResult } from '../../contracts/result';
import type { ResearchCitation } from '../../contracts/research-citation';
import type { ResearchWarning } from '../../contracts/warning';
import { computeContentHash } from '../../util/content-hash';
import type {
  SearchPort,
  WebSearchInput,
  WebSearchResultItem,
} from '../../ports/search';
import type { ConnectorRunContext, FetchLike } from '../types';
import { failure as httpFailure, resolveFetch, withTimeout } from '../http';

const PROVIDER = 'tavily';
const ENDPOINT = 'https://api.tavily.com/search';
const DEFAULT_TIMEOUT_MS = 12_000;

export interface TavilyOptions {
  /** Tavily API key (https://tavily.com). Absent → AUTH_REQUIRED. */
  apiKey?: string;
  fetchLike?: FetchLike;
  timeoutMs?: number;
  /** Map to Tavily's `search_depth`. Default 'basic'. */
  searchDepth?: 'basic' | 'advanced';
}

interface TavilyResult {
  title?: string;
  url?: string;
  content?: string;
  raw_content?: string | null;
  score?: number;
  published_date?: string;
}

interface TavilyResponse {
  results?: TavilyResult[];
  query?: string;
}

export function createTavilySearchConnector(options: TavilyOptions = {}): SearchPort {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const searchDepth = options.searchDepth ?? 'basic';

  return {
    async searchWeb(input: WebSearchInput, ctx: ConnectorRunContext = {}): Promise<ResearchResult<WebSearchResultItem[]>> {
      const retrievedAt = new Date().toISOString();
      if (!options.apiKey?.trim()) {
        return failure(
          retrievedAt,
          'AUTH_REQUIRED',
          'Tavily search requires an API key (TAVILY_API_KEY).',
        );
      }
      if (!input.query?.trim()) {
        return failure(retrievedAt, 'INVALID_INSTRUMENT', 'query is required');
      }

      const fetchLike = resolveFetch(ctx, options);

      try {
        return await withTimeout(ctx, timeoutMs, async (signal) => {
        const body: Record<string, unknown> = {
          api_key: options.apiKey,
          query: input.query,
          search_depth: searchDepth,
          max_results: clampLimit(input.limit),
        };
        const days = parseFreshnessDays(input.freshness);
        if (days !== undefined) body.days = days;
        if (input.domainAllowlist?.length) body.include_domains = input.domainAllowlist;
        if (input.domainBlocklist?.length) body.exclude_domains = input.domainBlocklist;

        const res = await fetchLike(ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal,
        });
        if (!res.ok) {
          // Tavily returns HTTP 432 with `{detail:{error:"... exceeds your
          // plan's set usage limit ..."}}` for quota over-limits — surface
          // as RATE_LIMITED so callers can distinguish from real outages.
          let detail = '';
          try {
            const errBody = (await res.json()) as { detail?: { error?: string } } | undefined;
            detail = errBody?.detail?.error ?? '';
          } catch {
            // ignore; fall back to status-only message
          }
          const isQuota = res.status === 432 || /usage limit|exceeds.*plan/i.test(detail);
          const code: ResearchWarning['code'] =
            res.status === 401 || res.status === 403
              ? 'AUTH_REQUIRED'
              : res.status === 429 || isQuota
                ? 'RATE_LIMITED'
                : 'SOURCE_UNAVAILABLE';
          const message = detail
            ? `Tavily HTTP ${res.status}: ${detail}`
            : `Tavily HTTP ${res.status}`;
          return failure(retrievedAt, code, message, `HTTP ${res.status}`);
        }
        const data = (await res.json()) as TavilyResponse;
        const results = data.results ?? [];

        const items: WebSearchResultItem[] = results
          .filter((r): r is TavilyResult & { url: string } => typeof r?.url === 'string')
          .map((r, idx) => toItem(r, retrievedAt, idx));
        const citations: ResearchCitation[] = items.map((item) => ({
          title: item.title ?? item.url ?? '(untitled)',
          url: item.url,
          sourceType: 'WEB',
          provider: PROVIDER,
          publishedAt: item.publishedAt,
          retrievedAt: item.retrievedAt,
          qualityTier: 'D', // PRD §8.4 — generic web aggregator
        }));

        return {
          schemaVersion: RESEARCH_SCHEMA_VERSION,
          data: items,
          citations,
          freshness: [{ provider: PROVIDER, asOf: retrievedAt, retrievedAt, stale: false }],
          warnings: [],
        };
        });
      } catch (err) {
        const message = (err as Error)?.message ?? String(err);
        return failure(retrievedAt, 'SOURCE_UNAVAILABLE', `Tavily fetch failed: ${message}`, message);
      }
    },
  };
}

function toItem(r: TavilyResult & { url: string }, retrievedAt: string, rank: number): WebSearchResultItem {
  const snippet = r.content ?? '';
  const contentHash = computeContentHash({ markdown: snippet, canonicalUrl: r.url });
  const item: WebSearchResultItem = {
    sourceType: 'WEB',
    provider: PROVIDER,
    url: r.url,
    retrievedAt,
    sensitivity: 'public',
    rank,
    contentHash,
  };
  if (r.title) item.title = r.title;
  if (snippet) item.snippet = snippet;
  if (r.published_date) item.publishedAt = r.published_date;
  return item;
}

function parseFreshnessDays(freshness: WebSearchInput['freshness']): number | undefined {
  if (!freshness) return undefined;
  const m = /^(\d+)d$/.exec(freshness);
  if (!m) return undefined;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function clampLimit(limit: number | undefined): number {
  if (!limit || limit <= 0) return 8;
  return Math.min(limit, 20);
}

function failure(
  retrievedAt: string,
  code: ResearchWarning['code'],
  message: string,
  cause?: string,
): ResearchResult<WebSearchResultItem[]> {
  return httpFailure<WebSearchResultItem[]>(PROVIDER, [], {
    retrievedAt,
    code,
    message,
    ...(cause ? { cause } : {}),
  });
}
