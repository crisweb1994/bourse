import { describe, expect, it, vi } from 'vitest';
import { CN } from '../../../markets/cn';
import { makeUnlockCalendarCN } from '../../../tools/cn/unlock-calendar';
import type { CnToolFetchLike } from '../../../tools/cn/_fetch-headers';

function fakeRes(opts: { ok?: boolean; status?: number; body: string }) {
  return {
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    text: () => Promise.resolve(opts.body),
  };
}

const ctx = { marketProfile: CN };

function daysFromNow(d: number): string {
  return new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10);
}

describe('tools/cn/unlockCalendar', () => {
  it('code 9201 / null result → graceful empty (no unlocks), not a throw', async () => {
    const body = JSON.stringify({
      result: null,
      success: false,
      message: '返回数据为空',
      code: 9201,
    });
    const fetchImpl: CnToolFetchLike = vi.fn(() =>
      Promise.resolve(fakeRes({ body })),
    );
    const tool = makeUnlockCalendarCN({ fetchImpl });
    const result = await tool.run!({ symbol: '600519.SS', market: 'CN' }, ctx);
    expect(result.data.events).toHaveLength(0);
    expect(result.citations).toHaveLength(1);
  });

  it('code 9501 / report config not found → still throws (rot stays visible)', async () => {
    const body = JSON.stringify({
      result: null,
      success: false,
      message: '报表配置不存在',
      code: 9501,
    });
    const fetchImpl: CnToolFetchLike = vi.fn(() =>
      Promise.resolve(fakeRes({ body })),
    );
    const tool = makeUnlockCalendarCN({ fetchImpl });
    await expect(
      tool.run!({ symbol: '600519.SS', market: 'CN' }, ctx),
    ).rejects.toThrow(/report config not found/);
  });

  it('returns events within daysAhead window', async () => {
    const futureDate = daysFromNow(30);
    const body = JSON.stringify({
      result: {
        data: [
          {
            FREE_DATE: `${futureDate} 00:00:00`,
            FREE_SHARES: 50000, // 万股 → 5e8 股
            LIFT_MARKET_CAP: 1_000_000, // 万元 → 100 亿元
            FREE_SHARES_TYPE: '首发原股东限售股',
          },
        ],
      },
    });
    const fetchImpl: CnToolFetchLike = vi.fn(() =>
      Promise.resolve(fakeRes({ body })),
    );
    const tool = makeUnlockCalendarCN({ fetchImpl });
    const result = await tool.run!(
      { symbol: '600519.SS', market: 'CN' },
      ctx,
    );
    expect(result.data.events).toHaveLength(1);
    expect(result.data.events[0]).toMatchObject({
      date: futureDate,
      shares: 500000000,
      type: '首发原股东限售股',
    });
    expect(result.data.events[0].marketValue).toBeCloseTo(100, 1);
  });

  it('skips events outside the window (past or beyond daysAhead)', async () => {
    const veryFar = daysFromNow(500);
    const past = daysFromNow(-30);
    const body = JSON.stringify({
      result: {
        data: [
          {
            FREE_DATE: `${veryFar} 00:00:00`,
            FREE_SHARES: 100,
            FREE_SHARES_TYPE: '股权激励',
          },
          {
            FREE_DATE: `${past} 00:00:00`,
            FREE_SHARES: 200,
            FREE_SHARES_TYPE: '定增',
          },
        ],
      },
    });
    const fetchImpl: CnToolFetchLike = vi.fn(() =>
      Promise.resolve(fakeRes({ body })),
    );
    const tool = makeUnlockCalendarCN({ fetchImpl });
    const result = await tool.run!(
      { symbol: '600519.SS', market: 'CN', daysAhead: 90 },
      ctx,
    );
    expect(result.data.events).toEqual([]);
  });

  it('defaults type to 未分类 when FREE_SHARES_TYPE missing', async () => {
    const futureDate = daysFromNow(10);
    const body = JSON.stringify({
      result: {
        data: [
          {
            FREE_DATE: `${futureDate} 00:00:00`,
            FREE_SHARES: 100,
          },
        ],
      },
    });
    const fetchImpl: CnToolFetchLike = vi.fn(() =>
      Promise.resolve(fakeRes({ body })),
    );
    const tool = makeUnlockCalendarCN({ fetchImpl });
    const result = await tool.run!(
      { symbol: '600519.SS', market: 'CN' },
      ctx,
    );
    expect(result.data.events[0].type).toBe('未分类');
    expect(result.data.events[0].marketValue).toBeUndefined();
  });

  it('throws retry-after on 429', async () => {
    const fetchImpl: CnToolFetchLike = vi.fn(() =>
      Promise.resolve(fakeRes({ ok: false, status: 429, body: '' })),
    );
    const tool = makeUnlockCalendarCN({ fetchImpl });
    await expect(
      tool.run!({ symbol: '600519.SS', market: 'CN' }, ctx),
    ).rejects.toThrow(/retry-after/i);
  });
});
