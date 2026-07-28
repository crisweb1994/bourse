import { describe, expect, it } from 'vitest';
import { createTencentCnFinanceConnector } from './tencent-cn';
import type { FetchLike } from '../types';

describe('Tencent CN history connector', () => {
  it('parses adjusted daily bars and filters the requested date range', async () => {
    const fetchLike: FetchLike = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        code: 0,
        data: {
          sh600519: {
            qfqday: [
              ['2026-07-24', '1400', '1410', '1420', '1390', '1000'],
              ['2026-07-27', '1410', '1430', '1440', '1400', '1200'],
            ],
          },
        },
      }),
    });
    const connector = createTencentCnFinanceConnector({ fetchLike });

    const response = await connector.getHistory({
      instrumentId: 'CN:600519',
      from: '2026-07-27',
      to: '2026-07-28',
      interval: '1d',
    });

    expect(response.data).toEqual([expect.objectContaining({
      timestamp: '2026-07-27',
      close: 1430,
      volume: 1200,
    })]);
    expect(response.citations[0]?.provider).toBe('tencent-cn-history');
  });
});
