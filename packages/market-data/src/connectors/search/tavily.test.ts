import { describe, expect, it } from 'vitest';
import type { FetchLike } from '../types';
import { createTavilySearchConnector } from './tavily';

function jsonFetch(body: unknown, ok = true, status = 200): FetchLike {
  return async () => ({ ok, status, json: async () => body });
}

describe('Tavily search connector', () => {
  it('returns AUTH_REQUIRED when no apiKey', async () => {
    const c = createTavilySearchConnector();
    const out = await c.searchWeb({ query: 'nvidia' });
    expect(out.warnings[0].code).toBe('AUTH_REQUIRED');
  });

  it('maps results into WebSearchResultItem[] with contentHash + tier=D', async () => {
    const c = createTavilySearchConnector({
      apiKey: 'k',
      fetchLike: jsonFetch({
        query: 'nvidia',
        results: [
          {
            title: 'Nvidia Q1',
            url: 'https://reuters.com/x',
            content: 'beat estimates',
            score: 0.9,
            published_date: '2026-05-19T00:00:00Z',
          },
        ],
      }),
    });
    const out = await c.searchWeb({ query: 'nvidia' });
    expect(out.data).toHaveLength(1);
    expect(out.data[0]).toMatchObject({
      sourceType: 'WEB',
      provider: 'tavily',
      title: 'Nvidia Q1',
      url: 'https://reuters.com/x',
      snippet: 'beat estimates',
      rank: 0,
    });
    expect(out.data[0].contentHash?.length).toBe(64);
    expect(out.citations[0].qualityTier).toBe('D');
  });

  it('forwards freshness as `days`', async () => {
    let captured: unknown;
    const fetchLike: FetchLike = async (_url, init) => {
      captured = JSON.parse(String(init?.body));
      return { ok: true, status: 200, json: async () => ({ results: [] }) };
    };
    const c = createTavilySearchConnector({ apiKey: 'k', fetchLike });
    await c.searchWeb({ query: 'nvidia', freshness: '7d', limit: 5 });
    expect((captured as { days: number }).days).toBe(7);
    expect((captured as { max_results: number }).max_results).toBe(5);
  });

  it('forwards allowlist + blocklist', async () => {
    let captured: unknown;
    const fetchLike: FetchLike = async (_url, init) => {
      captured = JSON.parse(String(init?.body));
      return { ok: true, status: 200, json: async () => ({ results: [] }) };
    };
    const c = createTavilySearchConnector({ apiKey: 'k', fetchLike });
    await c.searchWeb({
      query: 'nvidia',
      domainAllowlist: ['reuters.com'],
      domainBlocklist: ['reddit.com'],
    });
    expect((captured as { include_domains: string[] }).include_domains).toEqual(['reuters.com']);
    expect((captured as { exclude_domains: string[] }).exclude_domains).toEqual(['reddit.com']);
  });

  it('maps 401 → AUTH_REQUIRED, 429 → RATE_LIMITED, 500 → SOURCE_UNAVAILABLE', async () => {
    const make = (status: number) =>
      createTavilySearchConnector({ apiKey: 'k', fetchLike: jsonFetch({}, false, status) });
    const cases: [number, string][] = [
      [401, 'AUTH_REQUIRED'],
      [403, 'AUTH_REQUIRED'],
      [429, 'RATE_LIMITED'],
      [502, 'SOURCE_UNAVAILABLE'],
    ];
    for (const [status, code] of cases) {
      const out = await make(status).searchWeb({ query: 'x' });
      expect(out.warnings[0].code).toBe(code);
    }
  });

  it('rejects empty query', async () => {
    const c = createTavilySearchConnector({ apiKey: 'k', fetchLike: jsonFetch({}) });
    const out = await c.searchWeb({ query: '   ' });
    expect(out.warnings[0].code).toBe('INVALID_INSTRUMENT');
  });
});
