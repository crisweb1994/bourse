import { describe, expect, it, vi } from 'vitest';
import type { FetchLike } from '../types';
import { createAlphaVantageFinanceConnector } from './alpha-vantage';

function response(data: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
    text: async () => JSON.stringify(data),
  };
}

describe('Alpha Vantage finance connector', () => {
  it('parses quote, daily history, and company overview', async () => {
    const fetchLike: FetchLike = vi.fn(async (url) => {
      const value = String(url);
      if (value.includes('GLOBAL_QUOTE')) return response({
        'Global Quote': {
          '01. symbol': 'IBM', '02. open': '217.75', '03. high': '219.63',
          '04. low': '215.29', '05. price': '216.28', '06. volume': '8326066',
          '07. latest trading day': '2026-07-27', '08. previous close': '214.19',
          '09. change': '2.09', '10. change percent': '0.9758%',
        },
      });
      if (value.includes('TIME_SERIES_DAILY')) return response({
        'Time Series (Daily)': {
          '2026-07-27': { '1. open': '217.75', '2. high': '219.63', '3. low': '215.29', '4. close': '216.28', '5. volume': '8326066' },
          '2026-07-24': { '1. open': '214', '2. high': '216', '3. low': '213', '4. close': '214.19', '5. volume': '4000000' },
        },
      });
      return response({
        Symbol: 'IBM', Exchange: 'NYSE', Description: 'IBM is a technology company.',
        Sector: 'TECHNOLOGY', Industry: 'INFORMATION TECHNOLOGY SERVICES',
        OfficialSite: 'https://www.ibm.com', MarketCapitalization: '201795764000',
      });
    });
    const connector = createAlphaVantageFinanceConnector({ apiKey: 'test-key', fetchLike });

    const quote = await connector.getQuote({ instrumentId: 'US:IBM' });
    const history = await connector.getHistory({ instrumentId: 'US:IBM', from: '2026-07-01', to: '2026-07-28' });
    const profile = await connector.getProfile!({ instrumentId: 'US:IBM' });

    expect(quote.data).toMatchObject({ price: 216.28, changePct: 0.9758 });
    expect(history.data.map((bar) => bar.timestamp)).toEqual(['2026-07-24', '2026-07-27']);
    expect(profile.data).toMatchObject({ sector: 'TECHNOLOGY', marketCap: 201795764000 });
  });

  it('classifies quota messages and rejects unsupported markets', async () => {
    const fetchLike: FetchLike = vi.fn(async () => response({ Note: 'API call frequency limit reached' }));
    const connector = createAlphaVantageFinanceConnector({ apiKey: 'test-key', fetchLike });

    const limited = await connector.getQuote({ instrumentId: 'US:IBM' });
    const unsupported = await connector.getQuote({ instrumentId: 'HK:0700' });

    expect(limited.warnings[0]?.code).toBe('RATE_LIMITED');
    expect(unsupported.warnings[0]?.code).toBe('UNSUPPORTED_MARKET');
    expect(fetchLike).toHaveBeenCalledOnce();
  });
});
