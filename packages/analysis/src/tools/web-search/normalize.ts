import type { Citation } from '../../contracts/citation';
import type { SearchResultItem, SearchResults } from './types';

/**
 * Convert SearchResults → Citation[] for the dimension-layer citation
 * pipeline. Adapter-specific quirks (deduplication, host whitelisting)
 * should be handled here, not in the adapter itself.
 */
export function resultsToCitations(
  results: SearchResults,
  retrievedAtIso: string,
): Citation[] {
  const seen = new Set<string>();
  const out: Citation[] = [];
  for (const item of results.items) {
    if (seen.has(item.url)) continue;
    seen.add(item.url);
    out.push({
      title: item.title || item.url,
      url: item.url,
      sourceType: 'OTHER',
      retrievedAt: retrievedAtIso,
      // RFC rfc-web-search-backend-config §2.3: stamp the originating
      // adapter id so audit / UI can display [searxng] / [serper] etc.
      searchAdapter: results.provider,
    });
  }
  return out;
}

/**
 * Compact JSON payload fed back to the LLM as tool result. Keep small —
 * upstream chat.completions vendors charge per token on the round trip.
 */
export function resultsToToolMessageJson(results: SearchResults): string {
  const compact = {
    query: results.query,
    items: results.items.map((it: SearchResultItem) => ({
      title: it.title,
      url: it.url,
      snippet: it.snippet.slice(0, 400),
      ...(it.publishedAt ? { publishedAt: it.publishedAt } : {}),
      ...(it.source ? { source: it.source } : {}),
    })),
  };
  return JSON.stringify(compact);
}
