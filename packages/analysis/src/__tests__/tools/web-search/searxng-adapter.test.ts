import { describe, expect, it, vi } from 'vitest';
import { createSearxngAdapter } from '../../../tools/web-search/adapters/searxng';

function mockFetch(json: unknown, status = 200): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText: '',
    json: async () => json,
  }) as unknown as typeof fetch;
}

describe('searxng adapter', () => {
  it('accepts the official null publishedDate shape', async () => {
    const adapter = createSearxngAdapter({
      baseUrl: 'https://search.example.com',
      _internalFetch: mockFetch({
        results: [{
          title: 'Apple investor relations',
          url: 'https://www.apple.com/newsroom/',
          content: 'Company news',
          publishedDate: null,
          engine: 'bing',
        }],
      }),
    });

    const result = await adapter.search(
      { query: 'AAPL', count: 5 },
      { timeoutMs: 1000 },
    );

    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.publishedAt).toBeUndefined();
  });

  it('normalizes /search?format=json response into SearchResults', async () => {
    const adapter = createSearxngAdapter({
      baseUrl: 'https://search.example.com',
      _internalFetch: mockFetch({
        query: '沪电股份',
        results: [
          {
            title: '沪电股份2025年年报',
            url: 'https://example.com/annual',
            content: '年报摘要…',
            publishedDate: '2026-03-15T00:00:00Z',
            engine: 'bing',
          },
          {
            title: 'noise',
            url: 'not-a-url',
            content: 'x',
          },
        ],
      }),
    });

    const r = await adapter.search(
      { query: '沪电股份 年报', count: 5 },
      { timeoutMs: 5000 },
    );

    expect(r.provider).toBe('searxng');
    expect(r.items).toHaveLength(1);
    expect(r.items[0]?.url).toBe('https://example.com/annual');
    expect(r.items[0]?.publishedAt).toBe('2026-03-15T00:00:00Z');
    expect(r.items[0]?.source).toBe('bing');
    expect(r.cached).toBe(false);
    expect(r.costUsd).toBe(0);
  });

  it('drops time_range by default; forwards only when ≤1d (RFC fix 2026-05-19)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: '',
      json: async () => ({ query: 'x', results: [] }),
    }) as unknown as typeof fetch;

    const adapter = createSearxngAdapter({
      baseUrl: 'https://s.example.com/',
      _internalFetch: fetchMock,
    });

    // Default behavior: freshnessDays=14 → 'month' bucket → DROPPED.
    await adapter.search(
      { query: 'q', count: 3, freshnessDays: 14 },
      { timeoutMs: 5000 },
    );
    const url14d = (fetchMock as unknown as { mock: { calls: unknown[][] } })
      .mock.calls[0]?.[0] as string;
    expect(url14d).not.toContain('time_range');

    // freshnessDays=1 → 'day' bucket → FORWARDED (tight enough).
    await adapter.search(
      { query: 'q', count: 3, freshnessDays: 1 },
      { timeoutMs: 5000 },
    );
    const url1d = (fetchMock as unknown as { mock: { calls: unknown[][] } })
      .mock.calls[1]?.[0] as string;
    expect(url1d).toContain('time_range=day');
  });

  it('forwards any time_range bucket when SEARXNG_FORWARD_TIME_RANGE=true', async () => {
    const prev = process.env.SEARXNG_FORWARD_TIME_RANGE;
    process.env.SEARXNG_FORWARD_TIME_RANGE = 'true';
    try {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: '',
        json: async () => ({ query: 'x', results: [] }),
      }) as unknown as typeof fetch;

      const adapter = createSearxngAdapter({
        baseUrl: 'https://s.example.com/',
        _internalFetch: fetchMock,
      });

      await adapter.search(
        { query: 'q', count: 3, freshnessDays: 14 },
        { timeoutMs: 5000 },
      );
      const url = (fetchMock as unknown as { mock: { calls: unknown[][] } })
        .mock.calls[0]?.[0] as string;
      expect(url).toContain('time_range=month');
    } finally {
      if (prev === undefined) delete process.env.SEARXNG_FORWARD_TIME_RANGE;
      else process.env.SEARXNG_FORWARD_TIME_RANGE = prev;
    }
  });

  it('passes Bearer auth when apiKey is set', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: '',
      json: async () => ({ query: 'x', results: [] }),
    }) as unknown as typeof fetch;

    const adapter = createSearxngAdapter({
      baseUrl: 'https://s.example.com',
      apiKey: 'secret',
      _internalFetch: fetchMock,
    });

    await adapter.search({ query: 'q', count: 3 }, { timeoutMs: 5000 });
    const init = (fetchMock as unknown as { mock: { calls: unknown[][] } })
      .mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>).authorization).toBe(
      'Bearer secret',
    );
  });

  it('throws on non-2xx upstream', async () => {
    const adapter = createSearxngAdapter({
      baseUrl: 'https://s.example.com',
      _internalFetch: mockFetch({}, 503),
    });

    await expect(
      adapter.search({ query: 'q', count: 3 }, { timeoutMs: 5000 }),
    ).rejects.toThrow(/searxng HTTP 503/);
  });
});
