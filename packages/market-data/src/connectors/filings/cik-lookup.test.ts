import { describe, expect, it } from 'vitest';
import { createInMemoryCikLookup } from './cik-lookup';
import type { FetchLike } from '../types';

function stubFetch(body: unknown, ok = true, status = 200): FetchLike {
  return async () => ({ ok, status, json: async () => body });
}

const TABLE = {
  '0': { cik_str: 320193, ticker: 'AAPL', title: 'Apple Inc.' },
  '1': { cik_str: 1045810, ticker: 'NVDA', title: 'NVIDIA CORP' },
  '2': { cik_str: 1318605, ticker: 'TSLA', title: 'Tesla, Inc.' },
};

describe('createInMemoryCikLookup', () => {
  it('resolves ticker to padded CIK (case-insensitive)', async () => {
    const lookup = createInMemoryCikLookup({ userAgent: 'test', fetchLike: stubFetch(TABLE) });
    const out = await lookup.resolve('nvda');
    expect(out?.cik).toBe('0001045810');
    expect(out?.name).toBe('NVIDIA CORP');
  });

  it('returns null for unknown ticker', async () => {
    const lookup = createInMemoryCikLookup({ userAgent: 'test', fetchLike: stubFetch(TABLE) });
    expect(await lookup.resolve('XXX')).toBeNull();
  });

  it('caches the table — fetch called once across multiple resolves', async () => {
    let calls = 0;
    const fetchLike: FetchLike = async () => {
      calls += 1;
      return { ok: true, status: 200, json: async () => TABLE };
    };
    const lookup = createInMemoryCikLookup({ userAgent: 'test', fetchLike });
    await lookup.resolve('AAPL');
    await lookup.resolve('NVDA');
    await lookup.resolve('TSLA');
    expect(calls).toBe(1);
  });

  it('throws on SEC ticker table HTTP failure (caller turns into warning)', async () => {
    const lookup = createInMemoryCikLookup({ userAgent: 'test', fetchLike: stubFetch({}, false, 403) });
    await expect(lookup.resolve('AAPL')).rejects.toThrow(/HTTP 403/);
  });

  it('refreshes after TTL expires', async () => {
    let calls = 0;
    let nowMs = 1_000_000;
    const fetchLike: FetchLike = async () => {
      calls += 1;
      return { ok: true, status: 200, json: async () => TABLE };
    };
    const lookup = createInMemoryCikLookup({
      userAgent: 'test',
      fetchLike,
      ttlMs: 1_000,
      now: () => nowMs,
    });
    await lookup.resolve('AAPL');
    nowMs += 2_000;
    await lookup.resolve('AAPL');
    expect(calls).toBe(2);
  });
});
