import { describe, expect, it, vi } from 'vitest';
import type { FetchLike } from '../types';
import { createTwelveDataFinanceConnector } from './twelve-data';

function response(data: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
    text: async () => JSON.stringify(data),
  };
}

describe('Twelve Data finance connector', () => {
  it('parses quote, history, and profile contracts', async () => {
    const fetchLike: FetchLike = vi.fn(async (url) => {
      const value = String(url);
      if (value.includes('/quote?')) return response({
        symbol: 'AAPL', exchange: 'NASDAQ', currency: 'USD', timestamp: 1785159000,
        open: '334.90', high: '339.57', low: '334.02', close: '336.91',
        volume: '45246885', previous_close: '333.02', change: '3.89', percent_change: '1.1681',
      });
      if (value.includes('/time_series?')) return response({
        status: 'ok',
        values: [
          { datetime: '2026-07-24', open: '321.79', high: '334.37', low: '321.62', close: '333.02', volume: '47443900' },
          { datetime: '2026-07-27', open: '334.90', high: '339.57', low: '334.02', close: '336.91', volume: '45246885' },
        ],
      });
      return response({
        symbol: 'AAPL', exchange: 'NASDAQ', sector: 'Technology',
        industry: 'Consumer Electronics', employees: 166000,
        website: 'https://www.apple.com', description: 'Apple makes consumer technology products.',
      });
    });
    const connector = createTwelveDataFinanceConnector({ apiKey: 'test-key', fetchLike });

    const quote = await connector.getQuote({ instrumentId: 'US:AAPL' });
    const history = await connector.getHistory({
      instrumentId: 'US:AAPL', from: '2026-07-01', to: '2026-07-28', interval: '1d',
    });
    const profile = await connector.getProfile!({ instrumentId: 'US:AAPL' });

    expect(quote.data).toMatchObject({ price: 336.91, previousClose: 333.02, currency: 'USD' });
    expect(history.data).toHaveLength(2);
    expect(profile.data).toMatchObject({ sector: 'Technology', employees: 166000 });
    expect(quote.citations[0]?.provider).toBe('twelve-data');
  });

  it('maps HK and CN symbols to documented exchange-qualified identifiers', async () => {
    const urls: string[] = [];
    const fetchLike: FetchLike = async (url) => {
      urls.push(String(url));
      return response({ status: 'error', code: 404, message: 'not found' });
    };
    const connector = createTwelveDataFinanceConnector({ apiKey: 'test-key', fetchLike });

    await connector.getQuote({ instrumentId: 'HK:00700' });
    await connector.getQuote({ instrumentId: 'CN:600519' });

    expect(decodeURIComponent(urls[0]!)).toContain('symbol=0700:HKEX');
    expect(decodeURIComponent(urls[1]!)).toContain('symbol=600519:SSE');
  });

  it('classifies provider rate-limit errors', async () => {
    const connector = createTwelveDataFinanceConnector({
      apiKey: 'test-key',
      fetchLike: async () => response({ status: 'error', code: 429, message: 'API credits limit exceeded' }, 429),
    });

    const result = await connector.getQuote({ instrumentId: 'US:AAPL' });

    expect(result.warnings[0]?.code).toBe('RATE_LIMITED');
  });
});
