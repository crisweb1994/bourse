import { describe, expect, it, vi } from 'vitest';
import {
  SearchLimitReachedError,
  WebSearchExecutor,
} from '../../../tools/web-search/executor';
import type {
  AdapterContext,
  SearchQuery,
  SearchResults,
  WebSearchAdapter,
} from '../../../tools/web-search/types';

function fakeAdapter(opts: {
  costPerCall?: number;
  failTimes?: number;
  failWith?: string;
}): WebSearchAdapter & { calls: number } {
  let calls = 0;
  const adapter: WebSearchAdapter = {
    name: 'searxng',
    async search(q: SearchQuery, _ctx: AdapterContext): Promise<SearchResults> {
      calls += 1;
      (adapter as WebSearchAdapter & { calls: number }).calls = calls;
      if (opts.failTimes && calls <= opts.failTimes) {
        throw new Error(opts.failWith ?? 'timeout');
      }
      return {
        query: q.query,
        items: [
          {
            title: 'r1',
            url: 'https://example.com/r1',
            snippet: 's1',
          },
        ],
        provider: 'searxng',
        costUsd: opts.costPerCall ?? 0,
        durationMs: 5,
        cached: false,
      };
    },
  };
  (adapter as WebSearchAdapter & { calls: number }).calls = 0;
  return adapter as WebSearchAdapter & { calls: number };
}

describe('WebSearchExecutor', () => {
  it('caches identical queries within TTL', async () => {
    const adapter = fakeAdapter({ costPerCall: 0 });
    const ex = new WebSearchExecutor({
      adapter,
      timeoutMs: 5000,
      maxSearchesPerRun: 50,
      cacheTtlMs: 60_000,
    });
    const a = await ex.execute({ query: '沪电股份' });
    const b = await ex.execute({ query: '沪电股份' });
    expect(adapter.calls).toBe(1);
    expect(a.output.results.cached).toBe(false);
    expect(b.output.results.cached).toBe(true);
    expect(ex.stats().cacheHits).toBe(1);
  });

  it('throws SearchLimitReachedError when over cap', async () => {
    const adapter = fakeAdapter({ costPerCall: 0 });
    const ex = new WebSearchExecutor({
      adapter,
      timeoutMs: 5000,
      maxSearchesPerRun: 2,
      cacheTtlMs: 0,
    });
    const first = await ex.execute({ query: 'q1' });
    expect(first.limitReached).toBe(false);
    const second = await ex.execute({ query: 'q2' });
    expect(second.limitReached).toBe(true);
    await expect(ex.execute({ query: 'q3' })).rejects.toBeInstanceOf(
      SearchLimitReachedError,
    );
  });

  it('retries once on retryable error', async () => {
    const adapter = fakeAdapter({ failTimes: 1, failWith: 'timeout' });
    const ex = new WebSearchExecutor({
      adapter,
      timeoutMs: 5000,
      maxSearchesPerRun: 50,
      cacheTtlMs: 0,
    });
    const r = await ex.execute({ query: 'q' });
    expect(r.error).toBeUndefined();
    expect(adapter.calls).toBe(2);
  });

  it('does NOT let a retry bust the cap when only one slot is left', async () => {
    // Regression: previously the cap was checked only at execute() entry, so
    // a single execute() with cap=1 could burn 2 adapter calls when the
    // first attempt threw a retryable error. Now every adapter call (incl.
    // retry) consumes a slot AND is gated by a fresh cap check.
    const adapter = fakeAdapter({ failTimes: 5, failWith: 'http 429' });
    const ex = new WebSearchExecutor({
      adapter,
      timeoutMs: 5000,
      maxSearchesPerRun: 1,
      cacheTtlMs: 0,
    });
    // First attempt burns the only slot (callCount 0→1) and throws 429; the
    // retry must hit the in-loop cap check (1 >= 1) and reject with
    // SearchLimitReachedError instead of making a second adapter call.
    await expect(ex.execute({ query: 'q' })).rejects.toBeInstanceOf(
      SearchLimitReachedError,
    );
    expect(adapter.calls).toBe(1);
    expect(ex.stats().callCount).toBe(1);
  });

  it('surfaces non-retryable error to caller', async () => {
    const adapter = fakeAdapter({ failTimes: 5, failWith: 'invalid input' });
    const ex = new WebSearchExecutor({
      adapter,
      timeoutMs: 5000,
      maxSearchesPerRun: 50,
      cacheTtlMs: 0,
    });
    const r = await ex.execute({ query: 'q' });
    expect(r.error?.message).toMatch(/invalid input/);
    expect(r.output.results.items).toHaveLength(0);
  });

  it('produces tool message JSON containing query + items', async () => {
    const adapter = fakeAdapter({});
    const ex = new WebSearchExecutor({
      adapter,
      timeoutMs: 5000,
      maxSearchesPerRun: 50,
      cacheTtlMs: 0,
    });
    const r = await ex.execute({ query: 'hello' });
    const parsed = JSON.parse(r.output.text);
    expect(parsed.query).toBe('hello');
    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0].url).toBe('https://example.com/r1');
  });

  it('emits citations with retrievedAt', async () => {
    const adapter = fakeAdapter({});
    const ex = new WebSearchExecutor({
      adapter,
      timeoutMs: 5000,
      maxSearchesPerRun: 50,
      cacheTtlMs: 0,
    });
    const r = await ex.execute({ query: 'q' });
    expect(r.output.citations).toHaveLength(1);
    expect(r.output.citations[0]?.retrievedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('stamps searchAdapter on emitted citations (RFC ws-config §2.3)', async () => {
    const adapter = fakeAdapter({});
    const ex = new WebSearchExecutor({
      adapter,
      timeoutMs: 5000,
      maxSearchesPerRun: 50,
      cacheTtlMs: 0,
    });
    const r = await ex.execute({ query: 'q' });
    expect(r.output.citations[0]?.searchAdapter).toBe('searxng');
  });

  it('applies domainTierFilter: drops below-threshold hosts (RFC ws-config §2.4)', async () => {
    // Adapter that returns mixed-tier results.
    const adapter: WebSearchAdapter & { calls: number } = Object.assign(
      {
        name: 'searxng' as const,
        async search(q: SearchQuery): Promise<SearchResults> {
          return {
            query: q.query,
            items: [
              { title: 'A', url: 'https://eastmoney.com/p', snippet: 's' },
              { title: 'B', url: 'https://10jqka.com.cn/p', snippet: 's' },
              { title: 'X', url: 'https://spam.example/p', snippet: 's' },
            ],
            provider: 'searxng',
            costUsd: 0,
            durationMs: 5,
            cached: false,
          };
        },
      },
      { calls: 0 },
    );
    const ex = new WebSearchExecutor({
      adapter,
      timeoutMs: 5000,
      maxSearchesPerRun: 50,
      cacheTtlMs: 0,
      domainTierFilter: {
        tiers: {
          'eastmoney.com': 'A',
          '10jqka.com.cn': 'B',
          'spam.example': 'E',
        },
        dropBelow: 'D',
      },
    });
    const r = await ex.execute({ query: 'q' });
    const urls = r.output.results.items.map((it) => it.url);
    expect(urls).toContain('https://eastmoney.com/p');
    expect(urls).toContain('https://10jqka.com.cn/p');
    expect(urls).not.toContain('https://spam.example/p');
  });
});
