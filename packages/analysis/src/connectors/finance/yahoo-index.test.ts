import { describe, expect, it } from 'vitest';
import type { FetchLike } from '../types';
import {
  INDEX_NAMES,
  INDEX_SYMBOLS,
  fetchIndexHistory,
  fetchIndexQuote,
} from './yahoo';

function stubFetch(body: unknown, ok = true, status = 200): FetchLike {
  return async () => ({ ok, status, json: async () => body });
}

const gspcMeta = {
  currency: 'USD',
  symbol: '^GSPC',
  exchangeName: 'SNP',
  regularMarketPrice: 7354.02,
  previousClose: 7500.58,
  regularMarketTime: 1751030400,
};

function chartResponse(meta: Record<string, unknown> | null) {
  return { chart: { result: meta ? [{ meta }] : [], error: null } };
}

function chartError(code: string, desc: string) {
  return { chart: { result: null, error: { code, description: desc } } };
}

describe('yahoo index quotes (Daily Brief · DB.4)', () => {
  it('fetchIndexQuote parses chart meta into IndexQuote', async () => {
    const q = await fetchIndexQuote('^GSPC', { fetchLike: stubFetch(chartResponse(gspcMeta)) });
    expect(q).not.toBeNull();
    expect(q!.symbol).toBe('^GSPC');
    expect(q!.name).toBe('S&P 500');
    expect(q!.price).toBe(7354.02);
    expect(q!.previousClose).toBe(7500.58);
    expect(q!.change).toBeCloseTo(-146.56, 2);
    expect(q!.changePct).toBeCloseTo(-1.954, 2);
    expect(q!.currency).toBe('USD');
    expect(q!.exchange).toBe('SNP');
  });

  it('falls back to chartPreviousClose when previousClose missing', async () => {
    const meta = { ...gspcMeta, previousClose: undefined, chartPreviousClose: 7400 };
    const q = await fetchIndexQuote('^GSPC', { fetchLike: stubFetch(chartResponse(meta)) });
    expect(q!.previousClose).toBe(7400);
    expect(q!.change).toBeCloseTo(-45.98, 2);
  });

  it('returns null on chart error (e.g. ^HSTECH delisted)', async () => {
    const q = await fetchIndexQuote('^HSTECH', {
      fetchLike: stubFetch(chartError('Not Found', 'No data found, symbol may be delisted')),
    });
    expect(q).toBeNull();
  });

  it('returns null on HTTP non-ok', async () => {
    const q = await fetchIndexQuote('^GSPC', { fetchLike: stubFetch({}, false, 429) });
    expect(q).toBeNull();
  });

  it('returns null when meta missing', async () => {
    const q = await fetchIndexQuote('^GSPC', { fetchLike: stubFetch(chartResponse(null)) });
    expect(q).toBeNull();
  });

  it('fetchIndexHistory parses daily bars and skips null closes', async () => {
    const body = {
      chart: {
        result: [
          {
            timestamp: [1_700_000_000, 1_700_086_400, 1_700_172_800],
            indicators: {
              quote: [
                {
                  open: [100, null, 102],
                  high: [101, 105, 103],
                  low: [99, 100, 101],
                  close: [100.5, null, 102.5],
                  volume: [1000, 2000, 1500],
                },
              ],
              adjclose: [{ adjclose: [100.5, null, 102.5] }],
            },
          },
        ],
        error: null,
      },
    };
    const bars = await fetchIndexHistory('^GSPC', '2023-01-01', '2023-01-03', {
      fetchLike: stubFetch(body),
    });
    expect(bars).toHaveLength(2); // null close at index 1 skipped
    expect(bars![0]!.close).toBe(100.5);
    expect(bars![0]!.open).toBe(100);
    expect(bars![1]!.close).toBe(102.5);
    expect(bars![1]!.open).toBe(102); // null open falls back to close
  });

  it('fetchIndexHistory returns null on invalid range', async () => {
    const bars = await fetchIndexHistory('^GSPC', '2023-01-03', '2023-01-01', {
      fetchLike: stubFetch({}),
    });
    expect(bars).toBeNull();
  });

  it('INDEX_SYMBOLS covers US/CN/HK with verified symbols and names', () => {
    expect(INDEX_SYMBOLS.US).toContain('^GSPC');
    expect(INDEX_SYMBOLS.US).toContain('^IXIC');
    expect(INDEX_SYMBOLS.CN).toContain('000001.SS');
    expect(INDEX_SYMBOLS.HK).toEqual(['^HSI']);
    for (const m of ['US', 'CN', 'HK'] as const) {
      for (const s of INDEX_SYMBOLS[m]) {
        expect(INDEX_NAMES[s]).toBeTruthy();
      }
    }
  });
});
