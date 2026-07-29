import type {
  AdapterContext,
  SearchQuery,
  SearchResults,
  WebSearchAdapter,
} from '../types';

const TAVILY_ENDPOINT = 'https://api.tavily.com/search';

/**
 * Tavily web-search adapter. Web evidence is owned by analysis rather than
 * market-data: queries can contain user intent and results are evidence, not
 * normalized market facts.
 *
 * `apiKey` is required (Tavily auth model). Operator supplies it via
 * the user's WebSearchSetting row (apps/api WebSearchService) or env
 * fallback when calling `buildAdapterFromConfig`.
 */
export interface TavilyAdapterConfig {
  apiKey: string;
  /** Tavily `search_depth`. Default 'basic'; 'advanced' costs more credits. */
  searchDepth?: 'basic' | 'advanced';
  /** Test seam — bypass globalThis.fetch. */
  _internalFetch?: typeof fetch;
}

export function createTavilyAdapter(config: TavilyAdapterConfig): WebSearchAdapter {
  if (!config.apiKey?.trim()) {
    throw new Error('tavily adapter requires apiKey');
  }
  const doFetch = config._internalFetch ?? fetch;

  return {
    name: 'tavily',
    async search(query: SearchQuery, ctx: AdapterContext): Promise<SearchResults> {
      const startedAt = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), ctx.timeoutMs);
      const abort = () => controller.abort(ctx.signal?.reason);
      if (ctx.signal?.aborted) abort();
      else ctx.signal?.addEventListener('abort', abort, { once: true });
      let payload: TavilyResponse;
      try {
        const response = await doFetch(TAVILY_ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            api_key: config.apiKey,
            query: query.query,
            search_depth: config.searchDepth ?? 'basic',
            max_results: query.count,
            ...(query.freshnessDays ? { days: query.freshnessDays } : {}),
          }),
          signal: controller.signal,
        });
        if (!response.ok) {
          const suffix = response.status === 429 || response.status === 432
            ? ' retry-after: 30'
            : '';
          throw new Error(`tavily HTTP ${response.status}${suffix}`);
        }
        payload = await response.json() as TavilyResponse;
      } catch (error) {
        throw new Error(`tavily: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        clearTimeout(timer);
        ctx.signal?.removeEventListener('abort', abort);
      }

      return {
        query: query.query,
        items: (payload.results ?? [])
          .filter((item): item is TavilyResult & { url: string } => typeof item.url === 'string')
          .map((item) => ({
            title: item.title ?? item.url,
            url: item.url,
            snippet: item.content ?? '',
            ...(item.published_date ? { publishedAt: item.published_date } : {}),
            source: 'tavily',
          })),
        provider: 'tavily',
        costUsd: 0, // Tavily's per-request pricing is op-rated; left at 0 for now
        durationMs: Date.now() - startedAt,
        cached: false,
      };
    },
  };
}

interface TavilyResult {
  title?: string;
  url?: string;
  content?: string;
  published_date?: string;
}

interface TavilyResponse {
  results?: TavilyResult[];
}
