import { describe, expect, it } from 'vitest';
import type { FetchLike } from '../types';
import { createSinaUsFinanceConnector } from './sina';

function jsonp(rows: unknown): string {
  return `/* Sina JSONP */\nvar data=(${JSON.stringify(rows)});`;
}

function response(body: string, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
  } as Response;
}

describe('Sina US finance connector', () => {
  it('parses, sorts and filters daily OHLCV JSONP', async () => {
    const fetchLike: FetchLike = async () => response(jsonp([
      { d: '2026-07-24', o: '321.79', h: '334.37', l: '321.62', c: '333.02', v: '47489415' },
      { d: '2026-07-23', o: '321.73', h: '323.30', l: '319.35', c: '321.66', v: '40840780' },
      { d: 'bad', o: '-', h: '1', l: '1', c: '1', v: '1' },
    ]));
    const connector = createSinaUsFinanceConnector({ fetchLike });
    const out = await connector.getHistory({
      instrumentId: 'US:AAPL',
      from: '2026-07-23',
      to: '2026-07-24',
      interval: '1d',
    });

    expect(out.data).toHaveLength(2);
    expect(out.data[0]).toMatchObject({
      timestamp: '2026-07-23',
      open: 321.73,
      close: 321.66,
      volume: 40_840_780,
    });
    expect(out.data[1]?.close).toBe(333.02);
    expect(out.citations[0]).toMatchObject({
      provider: 'sina-finance',
      sourceType: 'PRICE',
      qualityTier: 'B',
    });
  });

  it('builds an end-of-day quote and shares one upstream request with history', async () => {
    let calls = 0;
    const fetchLike: FetchLike = async () => {
      calls += 1;
      return response(jsonp([
        { d: '2026-07-23', o: '320', h: '323', l: '319', c: '321', v: '100' },
        { d: '2026-07-24', o: '322', h: '335', l: '321', c: '333', v: '200' },
      ]));
    };
    const connector = createSinaUsFinanceConnector({ fetchLike });
    const [quote, history] = await Promise.all([
      connector.getQuote({ instrumentId: 'US:AAPL' }),
      connector.getHistory({ instrumentId: 'US:AAPL', from: '2026-07-01', to: '2026-07-24' }),
    ]);

    expect(calls).toBe(1);
    expect(quote.data).toMatchObject({
      price: 333,
      previousClose: 321,
      change: 12,
      currency: 'USD',
      marketStatus: 'UNKNOWN',
    });
    expect(history.data).toHaveLength(2);
    expect(quote.warnings.some((warning) => warning.code === 'PARTIAL_DATA')).toBe(true);
  });

  it('fails cleanly for null JSONP and non-US instruments', async () => {
    const fetchLike: FetchLike = async () => response('var data=(null);');
    const connector = createSinaUsFinanceConnector({ fetchLike });
    const empty = await connector.getHistory({
      instrumentId: 'US:NOTREAL',
      from: '2026-01-01',
      to: '2026-07-24',
    });
    const unsupported = await connector.getQuote({ instrumentId: 'HK:00700' });

    expect(empty.data).toEqual([]);
    expect(empty.warnings[0]?.code).toBe('SOURCE_UNAVAILABLE');
    expect(unsupported.data.price).toBeNaN();
    expect(unsupported.warnings[0]?.code).toBe('UNSUPPORTED_MARKET');
  });
});
