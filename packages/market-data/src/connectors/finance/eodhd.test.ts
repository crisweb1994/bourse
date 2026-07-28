import { describe, expect, it, vi } from 'vitest';
import type { FetchLike } from '../types';
import { createEodhdFinanceConnector } from './eodhd';

function response(data: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
    text: async () => typeof data === 'string' ? data : JSON.stringify(data),
  };
}

describe('EODHD finance connector', () => {
  it('parses real-time quote, EOD history, and General fundamentals', async () => {
    const fetchLike: FetchLike = vi.fn(async (url) => {
      const value = String(url);
      if (value.includes('/real-time/')) return response({
        timestamp: 1785184080, open: 334.54, high: 339.57, low: 334.02,
        close: 336.91, volume: 49256009, previousClose: 333.02, change: 3.89, change_p: 1.1681,
      });
      if (value.includes('/eod/')) return response([
        { date: '2026-07-24', open: 321.79, high: 334.37, low: 321.62, close: 333.02, adjusted_close: 333.02, volume: 47443900 },
        { date: '2026-07-27', open: 334.90, high: 339.57, low: 334.02, close: 336.91, adjusted_close: 336.91, volume: 45246885 },
      ]);
      return response({
        Exchange: 'NASDAQ', Description: 'Apple makes consumer technology products.',
        Sector: 'Technology', Industry: 'Consumer Electronics', WebURL: 'https://www.apple.com',
        FullTimeEmployees: 166000, UpdatedAt: '2026-07-26',
      });
    });
    const connector = createEodhdFinanceConnector({ apiKey: 'test-key', fetchLike });

    const quote = await connector.getQuote({ instrumentId: 'US:AAPL' });
    const history = await connector.getHistory({ instrumentId: 'US:AAPL', from: '2026-07-01', to: '2026-07-28' });
    const profile = await connector.getProfile!({ instrumentId: 'US:AAPL' });

    expect(quote.data).toMatchObject({ price: 336.91, previousClose: 333.02 });
    expect(history.data[0]).toMatchObject({ timestamp: '2026-07-24', adjustedClose: 333.02 });
    expect(profile.data).toMatchObject({ industry: 'Consumer Electronics', employees: 166000 });
  });

  it('maps HK and CN exchange symbols', async () => {
    const urls: string[] = [];
    const fetchLike: FetchLike = async (url) => {
      urls.push(String(url));
      return response('Forbidden', 403);
    };
    const connector = createEodhdFinanceConnector({ apiKey: 'test-key', fetchLike });

    await connector.getQuote({ instrumentId: 'HK:00700' });
    await connector.getQuote({ instrumentId: 'CN:600519' });

    expect(decodeURIComponent(urls[0]!)).toContain('/real-time/0700.HK?');
    expect(decodeURIComponent(urls[1]!)).toContain('/real-time/600519.SHG?');
  });

  it('classifies rejected credentials', async () => {
    const connector = createEodhdFinanceConnector({
      apiKey: 'bad-key',
      fetchLike: async () => response('Forbidden', 403),
    });

    const result = await connector.getQuote({ instrumentId: 'US:AAPL' });

    expect(result.warnings[0]?.code).toBe('AUTH_REQUIRED');
  });
});
