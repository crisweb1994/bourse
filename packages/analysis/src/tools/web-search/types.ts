import { z } from 'zod';
import type { Citation } from '../../contracts/citation';

/**
 * Pluggable web-search adapter contract.
 *
 * Each vendor (SearXNG / Serper / Tavily / Brave / Google PSE / Bing / Jina /
 * Exa) implements one `WebSearchAdapter`. Adapters are discovered via
 * `tools/web-search/registry.ts`, configured from env (Phase 1) or DB
 * (Phase 2), and dispatched by `WebSearchExecutor` when a chat.completions
 * model emits a `web_search` tool call.
 *
 * Citation policy: each `SearchResultItem.url` becomes a `Citation` with
 * sourceType='OTHER' (LLM-side dimension can refine). All URLs are then
 * gated through the standard §3-19 allowedUrls / provider-citation pipeline.
 */

export const WEB_SEARCH_PROVIDER_IDS = [
  'searxng',
  'tavily',
  // Phase 2 (not yet implemented):
  // 'serper', 'brave', 'google-pse', 'bing', 'jina', 'exa',
] as const;

export const WebSearchProviderId = z.enum(WEB_SEARCH_PROVIDER_IDS);
export type WebSearchProviderId = z.infer<typeof WebSearchProviderId>;

export const SearchQuery = z.object({
  query: z.string().min(1).max(400),
  count: z.number().int().min(1).max(20).default(8),
  freshnessDays: z.number().int().positive().optional(),
  language: z.string().optional(),
  region: z.string().optional(),
});
export type SearchQuery = z.infer<typeof SearchQuery>;

export const SearchResultItem = z.object({
  title: z.string().min(1),
  url: z.string().url(),
  snippet: z.string(),
  publishedAt: z.string().datetime().optional(),
  source: z.string().optional(),
});
export type SearchResultItem = z.infer<typeof SearchResultItem>;

export const SearchResults = z.object({
  query: z.string(),
  items: z.array(SearchResultItem),
  provider: WebSearchProviderId,
  costUsd: z.number().nonnegative().default(0),
  durationMs: z.number().nonnegative(),
  cached: z.boolean().default(false),
});
export type SearchResults = z.infer<typeof SearchResults>;

/**
 * Per-adapter runtime context. The executor passes signal+timeout in; the
 * adapter's own config (apiKey/baseUrl/extra) is closure-captured at
 * registry-instantiation time so adapters stay stateless functions.
 */
export interface AdapterContext {
  signal?: AbortSignal;
  timeoutMs: number;
}

export interface WebSearchAdapter {
  readonly name: WebSearchProviderId;
  search(query: SearchQuery, ctx: AdapterContext): Promise<SearchResults>;
}

/**
 * Public output of `WebSearchExecutor.execute()` — feeds back into the
 * chat.completions tool-call loop and surfaces citations to the dimension
 * runner. `text` is the JSON-stringified payload the LLM receives as the
 * `role:'tool'` message content.
 */
export interface WebSearchToolOutput {
  text: string;
  citations: Citation[];
  results: SearchResults;
}
