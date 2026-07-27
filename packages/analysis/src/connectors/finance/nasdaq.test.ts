import { describe, expect, it } from 'vitest';
import type { FetchLike } from '../types';
import { createNasdaqFinanceConnector } from './nasdaq';

function response(body: unknown, ok = true, status = 200): ReturnType<FetchLike> {
  return Promise.resolve({ ok, status, json: async () => body } as Response);
}

describe('Nasdaq finance connector', () => {
  it('parses a US quote with an exchange citation', async () => {
    const fetchLike: FetchLike = async () => response({
      data: {
        symbol: 'AAPL',
        exchange: 'NASDAQ-GS',
        marketStatus: 'Closed',
        primaryData: {
          lastSalePrice: '$333.02',
          netChange: '+11.36',
          percentageChange: '+3.53%',
          volume: '47,489,726',
          currency: 'USD',
          lastTradeTimestamp: '2026-07-24',
        },
      },
    });
    const connector = createNasdaqFinanceConnector();
    const out = await connector.getQuote(
      { instrumentId: 'US:AAPL' },
      { fetchLike },
    );

    expect(out.data.price).toBe(333.02);
    expect(out.data.change).toBe(11.36);
    expect(out.data.changePct).toBe(3.53);
    expect(out.data.volume).toBe(47_489_726);
    expect(out.data.marketStatus).toBe('CLOSED');
    expect(out.data.instrument.providerSymbols?.nasdaq).toBe('AAPL');
    expect(out.citations[0]).toMatchObject({
      provider: 'nasdaq',
      sourceType: 'PRICE',
      qualityTier: 'A',
      url: 'https://www.nasdaq.com/market-activity/stocks/AAPL',
    });
  });

  it('parses and sorts ISO-date daily history', async () => {
    let requestUrl = '';
    const fetchLike: FetchLike = async (url) => {
      requestUrl = String(url);
      return response({
        data: {
          tradesTable: {
            rows: [
              { date: '07/24/2026', close: '$333.02', volume: '47,489,420', open: '$321.79', high: '$334.37', low: '$321.62' },
              { date: '07/23/2026', close: '$321.66', volume: '40,840,780', open: '$321.73', high: '$323.30', low: '$319.35' },
            ],
          },
        },
      });
    };
    const connector = createNasdaqFinanceConnector();
    const out = await connector.getHistory(
      {
        instrumentId: 'US:AAPL',
        from: '2026-07-01',
        to: '2026-07-26',
        interval: '1d',
      },
      { fetchLike },
    );

    expect(requestUrl).toContain('fromdate=2026-07-01');
    expect(requestUrl).toContain('todate=2026-07-26');
    expect(out.data).toHaveLength(2);
    expect(out.data[0]).toMatchObject({
      timestamp: '2026-07-23T00:00:00.000Z',
      close: 321.66,
      volume: 40_840_780,
    });
    expect(out.data[1]?.close).toBe(333.02);
    expect(out.citations[0]?.provider).toBe('nasdaq');
  });

  it('rejects non-US instruments without making a request', async () => {
    let called = false;
    const fetchLike: FetchLike = async () => {
      called = true;
      return response({});
    };
    const connector = createNasdaqFinanceConnector();
    const out = await connector.getQuote({ instrumentId: 'HK:00700' }, { fetchLike });

    expect(called).toBe(false);
    expect(out.data.price).toBeNaN();
    expect(out.warnings[0]?.code).toBe('UNSUPPORTED_MARKET');
  });

  it('returns a source-unavailable envelope on an upstream error', async () => {
    const fetchLike: FetchLike = async () => response({}, false, 503);
    const connector = createNasdaqFinanceConnector();
    const out = await connector.getHistory(
      { instrumentId: 'US:AAPL', from: '2026-07-01', to: '2026-07-26' },
      { fetchLike },
    );

    expect(out.data).toEqual([]);
    expect(out.warnings[0]).toMatchObject({
      code: 'SOURCE_UNAVAILABLE',
      cause: 'HTTP 503',
    });
  });
});
