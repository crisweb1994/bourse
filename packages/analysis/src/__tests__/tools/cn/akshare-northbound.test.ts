import { describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../../../tools/types';
import { makeAkshareNorthboundCN } from '../../../tools/cn/akshare-northbound';
import type { CnToolFetchLike } from '../../../tools/cn/_fetch-headers';

const ctx: ToolContext = {
  marketProfile: undefined,
  signal: undefined,
} as unknown as ToolContext;

function fakeRes({ body, status = 200 }: { body: unknown; status?: number }) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
    json: () => Promise.resolve(typeof body === 'string' ? JSON.parse(body) : body),
  };
}

describe('tools/cn/akshareNorthbound', () => {
  it('parses Eastmoney HSGT hold-detail mirror response', async () => {
    const body = {
      result: {
        data: [
          {
            HOLD_DATE: '2026-05-22 00:00:00',
            MUTUAL_TYPE: '1', // hgt
            ADD_MARKET_CAP: 12_500_000,
            HOLD_SHARES_NUM: 4_800_000,
            HOLD_MARKET_CAP: 95.6,
            SHARES_HOLDRATIO: 5.32,
          },
          {
            HOLD_DATE: '2026-05-21 00:00:00',
            MUTUAL_TYPE: '1',
            ADD_MARKET_CAP: -5_200_000,
            HOLD_SHARES_NUM: 4_700_000,
            HOLD_MARKET_CAP: 92.3,
            SHARES_HOLDRATIO: 5.21,
          },
        ],
      },
    };
    const fetchImpl: CnToolFetchLike = vi.fn(() => Promise.resolve(fakeRes({ body })));
    const tool = makeAkshareNorthboundCN({ fetchImpl });
    const result = await tool.run!(
      { symbol: '600519.SS', market: 'CN', daysBack: 5 },
      ctx,
    );

    expect(result.data.rows).toHaveLength(2);
    expect(result.data.rows[0]!.date).toBe('2026-05-22');
    expect(result.data.rows[0]!.hgt).toBe(12_500_000);
    expect(result.data.rows[0]!.sgt).toBe(0);
    expect(result.data.rows[0]!.holdShares).toBe(4_800_000);
    expect(result.data.rows[0]!.holdPctOfFloat).toBeCloseTo(0.0532, 4);
    expect(result.data.sourceMirror).toBe('eastmoney-datacenter');
  });

  it('falls forward to the next mirror when first returns empty rows', async () => {
    const calls: string[] = [];
    const fetchImpl: CnToolFetchLike = vi.fn((url) => {
      calls.push(typeof url === 'string' ? url : String(url));
      if (calls.length === 1) {
        // 1st mirror returns no rows
        return Promise.resolve(fakeRes({ body: { result: { data: [] } } }));
      }
      // 2nd mirror returns klines
      return Promise.resolve(
        fakeRes({
          body: {
            data: {
              klines: [
                '2026-05-22,150000000,0,0,0,0,0,0',
                '2026-05-21,-100000000,0,0,0,0,0,0',
              ],
            },
          },
        }),
      );
    });
    const tool = makeAkshareNorthboundCN({ fetchImpl });
    const result = await tool.run!(
      { symbol: '600519.SS', market: 'CN', daysBack: 5 },
      ctx,
    );
    expect(calls).toHaveLength(2);
    expect(result.data.sourceMirror).toBe('eastmoney-push2-flow');
    expect(result.data.rows[0]!.hgt).toBeCloseTo(1.5, 4); // 1.5亿元
    expect(result.data.rows[0]!.date).toBe('2026-05-22');
  });

  it('throws with not_implemented reason when ALL mirrors fail', async () => {
    const fetchImpl: CnToolFetchLike = vi.fn(() =>
      Promise.resolve(fakeRes({ body: { result: { data: [] } } })),
    );
    const tool = makeAkshareNorthboundCN({ fetchImpl });
    try {
      await tool.run!({ symbol: '600519.SS', market: 'CN' }, ctx);
      throw new Error('expected throw');
    } catch (e) {
      expect((e as Error).message).toMatch(/all mirrors failed/);
      expect((e as Error & { reason?: string }).reason).toBe('not_implemented');
    }
  });

  it('propagates 429 retry-after immediately, no fallthrough', async () => {
    const fetchImpl: CnToolFetchLike = vi.fn(() =>
      Promise.resolve({
        ok: false,
        status: 429,
        text: () => Promise.resolve(''),
        json: () => Promise.resolve({}),
      }),
    );
    const tool = makeAkshareNorthboundCN({ fetchImpl });
    await expect(
      tool.run!({ symbol: '600519.SS', market: 'CN' }, ctx),
    ).rejects.toThrow(/retry-after/);
  });

  it('caps result length at daysBack', async () => {
    const rows = Array.from({ length: 50 }, (_, i) => ({
      HOLD_DATE: `2026-05-${String(i + 1).padStart(2, '0')}`,
      MUTUAL_TYPE: '1',
      ADD_MARKET_CAP: i * 1000,
      HOLD_SHARES_NUM: 100,
      HOLD_MARKET_CAP: 10,
      SHARES_HOLDRATIO: 1.5,
    }));
    const fetchImpl: CnToolFetchLike = vi.fn(() =>
      Promise.resolve(fakeRes({ body: { result: { data: rows } } })),
    );
    const tool = makeAkshareNorthboundCN({ fetchImpl });
    const result = await tool.run!(
      { symbol: '600519.SS', market: 'CN', daysBack: 10 },
      ctx,
    );
    expect(result.data.rows).toHaveLength(10);
  });
});
