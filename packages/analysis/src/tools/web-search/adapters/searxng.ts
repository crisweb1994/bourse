import { z } from 'zod';
import type {
  AdapterContext,
  SearchQuery,
  SearchResults,
  WebSearchAdapter,
} from '../types';

/**
 * SearXNG adapter. Targets the `/search` JSON endpoint of any SearXNG
 * instance (self-hosted or public). Docs:
 * https://docs.searxng.org/dev/search_api.html
 *
 * Auth model: most public instances are open; private deployments may sit
 * behind a Basic-Auth proxy. We pass `Authorization: Bearer <apiKey>` when
 * configured — operators put whatever scheme their proxy expects upstream.
 *
 * Time freshness: SearXNG supports `time_range=day|week|month|year` only;
 * we map `freshnessDays` to the smallest bucket that covers it.
 */

const SearxngItem = z.object({
  title: z.string().default(''),
  url: z.string(),
  content: z.string().default(''),
  publishedDate: z.string().optional(),
  engine: z.string().optional(),
});

const SearxngResponse = z.object({
  query: z.string().optional(),
  results: z.array(SearxngItem).default([]),
});

function freshnessToBucket(days?: number): string | undefined {
  if (!days) return undefined;
  if (days <= 1) return 'day';
  if (days <= 7) return 'week';
  if (days <= 31) return 'month';
  return 'year';
}

export interface SearxngAdapterConfig {
  baseUrl: string;
  apiKey?: string;
  /** Test-only fetch injection. */
  _internalFetch?: typeof fetch;
}

export function createSearxngAdapter(
  config: SearxngAdapterConfig,
): WebSearchAdapter {
  const baseUrl = config.baseUrl.replace(/\/+$/, '');
  const doFetch: typeof fetch = config._internalFetch ?? fetch;

  return {
    name: 'searxng',
    async search(
      query: SearchQuery,
      ctx: AdapterContext,
    ): Promise<SearchResults> {
      const start = Date.now();
      const params = new URLSearchParams({
        q: query.query,
        format: 'json',
        safesearch: '0',
        // SearXNG returns up to ~10/page; rely on first-page results.
        pageno: '1',
      });
      if (query.language) params.set('language', query.language);
      // Hotfix (2026-05-19): SearXNG `time_range=day|week|month|year` causes
      // most upstream engines (brave / google / startpage / duckduckgo) to
      // either return 0 or get CAPTCHA-locked; engines that don't honor it
      // (bing / baidu / sogou) get aggregator-dropped too. Net effect: any
      // call with time_range set returns 0 hits while the same query
      // without it returns 10+. The model emits freshnessDays liberally
      // (it asks for "stock price within 7d" etc.) so honoring it blindly
      // costs us all results. We now only forward time_range when ≤ 1 day
      // — the only band tight enough to be worth losing engines for.
      const bucket = freshnessToBucket(query.freshnessDays);
      const shouldForwardBucket =
        bucket === 'day' || process.env?.SEARXNG_FORWARD_TIME_RANGE === 'true';
      if (bucket && shouldForwardBucket) params.set('time_range', bucket);

      const url = `${baseUrl}/search?${params.toString()}`;

      // Compose timeout from ctx and an inner AbortController, so both
      // the executor's outer signal and our own deadline can abort the fetch.
      const innerCtl = new AbortController();
      const timeoutHandle = setTimeout(
        () => innerCtl.abort(new Error('searxng-timeout')),
        ctx.timeoutMs,
      );
      const onOuterAbort = (): void => innerCtl.abort(ctx.signal?.reason);
      ctx.signal?.addEventListener('abort', onOuterAbort, { once: true });

      try {
        const headers: Record<string, string> = {
          accept: 'application/json',
          'user-agent': 'bourse-agent/web-search-searxng',
        };
        if (config.apiKey) {
          headers.authorization = `Bearer ${config.apiKey}`;
        }

        const res = await doFetch(url, {
          method: 'GET',
          headers,
          signal: innerCtl.signal,
        });

        if (!res.ok) {
          throw new Error(
            `searxng HTTP ${res.status} ${res.statusText || ''}`.trim(),
          );
        }

        const raw = (await res.json()) as unknown;
        const parsed = SearxngResponse.parse(raw);
        const rawCount = parsed.results.length;

        const items = parsed.results
          .filter((r) => isHttpUrl(r.url) && (r.title || r.content))
          .slice(0, query.count)
          .map((r) => ({
            title: r.title || r.url,
            url: r.url,
            snippet: r.content,
            ...(r.publishedDate && isIsoDateTime(r.publishedDate)
              ? { publishedAt: r.publishedDate }
              : {}),
            ...(r.engine ? { source: r.engine } : {}),
          }));

        // Diag (2026-05-19): when SearXNG returns 200 but with 0 raw results
        // it's almost always one of three things — JSON format not enabled
        // in settings.yml, upstream engines all blocked / rate-limited, or
        // bot detection serving empty body. Print enough to triage without
        // dumping the whole payload (which can be large HTML in edge cases).
        if (rawCount === 0) {
          let bodySample = '';
          try {
            bodySample = JSON.stringify(raw).slice(0, 200);
          } catch {
            bodySample = '<non-serializable>';
          }
          // eslint-disable-next-line no-console
          console.warn(
            `[searxng] 0 results · q=${JSON.stringify(query.query)} · ` +
              `url=${url} · status=${res.status} · ` +
              `bodySample=${bodySample}`,
          );
        } else if (rawCount > 0 && items.length === 0) {
          // eslint-disable-next-line no-console
          console.warn(
            `[searxng] all ${rawCount} results filtered out · q=${JSON.stringify(query.query)} · ` +
              `(missing url/title/content or non-HTTP scheme)`,
          );
        }

        return {
          query: query.query,
          items,
          provider: 'searxng',
          costUsd: 0,
          durationMs: Date.now() - start,
          cached: false,
        };
      } finally {
        clearTimeout(timeoutHandle);
        ctx.signal?.removeEventListener('abort', onOuterAbort);
      }
    },
  };
}

function isHttpUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function isIsoDateTime(s: string): boolean {
  return !Number.isNaN(Date.parse(s));
}
