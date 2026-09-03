import { z } from 'zod';
import type {
  AdapterContext,
  SearchQuery,
  SearchResults,
  WebSearchAdapter,
} from '../types';

const SearxngItem = z.object({
  title: z.string().default(''),
  url: z.string(),
  content: z.string().default(''),
  publishedDate: z.string().nullish(),
  engine: z.string().optional(),
});

const SearxngResponse = z.object({
  query: z.string().optional(),
  results: z.array(SearxngItem).default([]),
});

export interface SearxngAdapterConfig {
  baseUrl: string;
  apiKey?: string;
  /** Test-only fetch injection. */
  _internalFetch?: typeof fetch;
}

/**
 * SearXNG is web evidence acquisition, so its adapter lives with the
 * analysis tool executor rather than the normalized market-data router.
 */
export function createSearxngAdapter(config: SearxngAdapterConfig): WebSearchAdapter {
  const baseUrl = config.baseUrl.replace(/\/+$/, '');
  const doFetch = config._internalFetch ?? fetch;

  return {
    name: 'searxng',
    async search(query: SearchQuery, ctx: AdapterContext): Promise<SearchResults> {
      const startedAt = Date.now();
      const params = new URLSearchParams({
        q: query.query,
        format: 'json',
        safesearch: '0',
        pageno: '1',
      });
      if (query.language) params.set('language', query.language);
      const bucket = freshnessToBucket(query.freshnessDays);
      if (bucket && bucket === 'day') {
        params.set('time_range', bucket);
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error('searxng-timeout')), ctx.timeoutMs);
      const abort = () => controller.abort(ctx.signal?.reason);
      if (ctx.signal?.aborted) abort();
      else ctx.signal?.addEventListener('abort', abort, { once: true });
      try {
        const response = await doFetch(`${baseUrl}/search?${params.toString()}`, {
          method: 'GET',
          headers: {
            accept: 'application/json',
            'user-agent': 'bourse-analysis/web-search-searxng',
            ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
          },
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(`searxng HTTP ${response.status} ${response.statusText || ''}`.trim());
        }

        const payload = SearxngResponse.parse(await response.json());
        return {
          query: query.query,
          items: payload.results
            .filter((item) => isHttpUrl(item.url) && Boolean(item.title || item.content))
            .slice(0, query.count)
            .map((item) => ({
              title: item.title || item.url,
              url: item.url,
              snippet: item.content,
              ...(item.publishedDate && isIsoDateTime(item.publishedDate)
                ? { publishedAt: item.publishedDate }
                : {}),
              ...(item.engine ? { source: item.engine } : {}),
            })),
          provider: 'searxng',
          costUsd: 0,
          durationMs: Date.now() - startedAt,
          cached: false,
        };
      } finally {
        clearTimeout(timer);
        ctx.signal?.removeEventListener('abort', abort);
      }
    },
  };
}

function freshnessToBucket(days?: number): string | undefined {
  if (!days) return undefined;
  if (days <= 1) return 'day';
  if (days <= 7) return 'week';
  if (days <= 31) return 'month';
  return 'year';
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function isIsoDateTime(value: string): boolean {
  return !Number.isNaN(Date.parse(value));
}
