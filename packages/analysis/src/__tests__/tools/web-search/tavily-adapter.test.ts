import { describe, expect, it } from 'vitest';
import { createTavilyAdapter } from '../../../tools/web-search/adapters/tavily';

const ctx = { timeoutMs: 5000 };

function fakeTavilyFetch(body: unknown, ok = true, status = 200): typeof fetch {
  return (async () => ({
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  })) as unknown as typeof fetch;
}

describe('tavily web-search adapter', () => {
  it('requires apiKey', () => {
    expect(() => createTavilyAdapter({ apiKey: '' })).toThrow(/apiKey/);
  });

  it('maps research-core results to agent SearchResults', async () => {
    const adapter = createTavilyAdapter({
      apiKey: 'tvly-k',
      _internalFetch: fakeTavilyFetch({
        query: 'nvidia',
        results: [
          {
            title: 'Nvidia Q1',
            url: 'https://reuters.com/x',
            content: 'beat estimates',
            published_date: '2026-05-19T00:00:00Z',
          },
        ],
      }),
    });
    const out = await adapter.search({ query: 'nvidia', count: 5 }, ctx);
    expect(out.provider).toBe('tavily');
    expect(out.items).toHaveLength(1);
    expect(out.items[0]).toMatchObject({
      title: 'Nvidia Q1',
      url: 'https://reuters.com/x',
      snippet: 'beat estimates',
      source: 'tavily',
    });
  });

  it('throws (with retry-after hint) on Tavily 429', async () => {
    const adapter = createTavilyAdapter({
      apiKey: 'tvly-k',
      _internalFetch: fakeTavilyFetch({}, false, 429),
    });
    await expect(adapter.search({ query: 'x', count: 5 }, ctx)).rejects.toThrow(/retry-after/);
  });

  it('throws on 401 (auth) when no usable data returned', async () => {
    const adapter = createTavilyAdapter({
      apiKey: 'tvly-k',
      _internalFetch: fakeTavilyFetch({}, false, 401),
    });
    await expect(adapter.search({ query: 'x', count: 5 }, ctx)).rejects.toThrow(/tavily/);
  });

  it('forwards freshnessDays into the connector', async () => {
    let capturedBody: unknown;
    const adapter = createTavilyAdapter({
      apiKey: 'tvly-k',
      _internalFetch: (async (_url: string, init?: { body?: BodyInit }) => {
        capturedBody = init?.body ? JSON.parse(String(init.body)) : null;
        return {
          ok: true,
          status: 200,
          json: async () => ({ query: 'x', results: [] }),
          text: async () => '',
        };
      }) as unknown as typeof fetch,
    });
    await adapter.search({ query: 'x', count: 5, freshnessDays: 7 }, ctx);
    expect((capturedBody as { days: number }).days).toBe(7);
  });
});
