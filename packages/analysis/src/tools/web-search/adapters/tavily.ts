import { createTavilySearchConnector } from '../../../connectors/search/tavily';
import type {
  AdapterContext,
  SearchQuery,
  SearchResults,
  WebSearchAdapter,
} from '../types';

/**
 * Tavily web-search adapter. Delegates to research-core's Tavily
 * connector so the HTTP/parse logic lives in one place (A3 终态:
 * agent → research-core). This file is a thin idiom translator:
 *
 *   agent SearchQuery ↔ research-core WebSearchInput
 *   research-core WebSearchResultItem[] ↔ agent SearchResultItem[]
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
  const connector = createTavilySearchConnector({
    apiKey: config.apiKey,
    ...(config.searchDepth ? { searchDepth: config.searchDepth } : {}),
    ...(config._internalFetch
      ? {
          fetchLike: async (url, init) => {
            const r = await config._internalFetch!(url, init as RequestInit | undefined);
            return {
              ok: r.ok,
              status: r.status,
              json: async () => r.json(),
              text: async () => r.text(),
            };
          },
        }
      : {}),
  });

  return {
    name: 'tavily',
    async search(query: SearchQuery, ctx: AdapterContext): Promise<SearchResults> {
      const startedAt = Date.now();
      const result = await connector.searchWeb(
        {
          query: query.query,
          limit: query.count,
          ...(query.freshnessDays ? { freshness: `${query.freshnessDays}d` } : {}),
        },
        ctx.signal ? { signal: ctx.signal, timeoutMs: ctx.timeoutMs } : { timeoutMs: ctx.timeoutMs },
      );

      // research-core surfaces failures as warnings; agent's executor
      // expects a thrown error on hard failure so the gateway can record
      // it. Translate the most common failure codes.
      const fatal = result.warnings.find(
        (w) =>
          w.code === 'AUTH_REQUIRED' ||
          w.code === 'SOURCE_UNAVAILABLE' ||
          w.code === 'RATE_LIMITED',
      );
      if (fatal && result.data.length === 0) {
        const msg = fatal.code === 'RATE_LIMITED' ? `tavily 429 retry-after: 30` : `tavily: ${fatal.message}`;
        throw new Error(msg);
      }

      return {
        query: query.query,
        items: result.data.map((d) => ({
          title: d.title ?? d.url ?? '(untitled)',
          url: d.url ?? '',
          snippet: d.snippet ?? '',
          ...(d.publishedAt ? { publishedAt: d.publishedAt } : {}),
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
