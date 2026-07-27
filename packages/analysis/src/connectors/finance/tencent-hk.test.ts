import { describe, expect, it } from 'vitest';
import type { FetchLike } from '../types';
import { createTencentHkFinanceConnector } from './tencent-hk';

function response(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as Response;
}

describe('Tencent HK finance connector', () => {
  it('parses HK daily bars and shares the request with its EOD quote', async () => {
    let calls = 0;
    const fetchLike: FetchLike = async (url) => {
      calls += 1;
      expect(String(url)).toContain('param=hk00700,day,,,320,qfq');
      return response({
        code: 0,
        data: {
          hk00700: {
            day: [
              ['2026-07-23', '430.0', '434.6', '436.0', '428.0', '1000'],
              ['2026-07-24', '438.8', '443.0', '446.4', '435.4', '2000'],
            ],
          },
        },
      });
    };
    const connector = createTencentHkFinanceConnector({ fetchLike });
    const [quote, history] = await Promise.all([
      connector.getQuote({ instrumentId: 'HK:0700' }),
      connector.getHistory({ instrumentId: 'HK:0700', from: '2026-07-01', to: '2026-07-24' }),
    ]);

    expect(calls).toBe(1);
    expect(quote.data).toMatchObject({ price: 443, previousClose: 434.6, currency: 'HKD' });
    expect(quote.data.instrument.symbol).toBe('00700');
    expect(history.data).toHaveLength(2);
    expect(history.data[1]).toMatchObject({ open: 438.8, high: 446.4, low: 435.4, close: 443 });
    expect(history.citations[0]).toMatchObject({ provider: 'tencent-finance', qualityTier: 'B' });
  });

  it('rejects non-HK instruments without calling upstream', async () => {
    let called = false;
    const connector = createTencentHkFinanceConnector({
      fetchLike: async () => {
        called = true;
        return response({});
      },
    });
    const out = await connector.getQuote({ instrumentId: 'US:AAPL' });
    expect(called).toBe(false);
    expect(out.data.price).toBeNaN();
    expect(out.warnings[0]?.code).toBe('UNSUPPORTED_MARKET');
  });
});
