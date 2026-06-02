import { describe, expect, it, vi } from 'vitest';
import { CN } from '../../../markets/cn';
import { makeLhbScanCN } from '../../../tools/cn/lhb-scan';
import type { CnToolFetchLike } from '../../../tools/cn/_fetch-headers';

function fakeRes(opts: { ok?: boolean; status?: number; body: string }) {
  return {
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    text: () => Promise.resolve(opts.body),
  };
}

const ctx = { marketProfile: CN };
// Days back tests use long window so all fixture dates fall within range.
const wideWindow = { daysBack: 90 } as const;

describe('tools/cn/lhbScan', () => {
  it('code 9201 / null result → graceful empty appearances, not a throw', async () => {
    const body = JSON.stringify({
      result: null,
      success: false,
      message: '返回数据为空',
      code: 9201,
    });
    const fetchImpl: CnToolFetchLike = vi.fn(() =>
      Promise.resolve(fakeRes({ body })),
    );
    const tool = makeLhbScanCN({ fetchImpl });
    const result = await tool.run!(
      { symbol: '600519.SS', market: 'CN', ...wideWindow },
      ctx,
    );
    expect(result.data.appearances).toHaveLength(0);
  });

  it('groups rows by date and collects top buy/sell seats', async () => {
    const today = new Date();
    const recent = today.toISOString().slice(0, 10);
    const body = JSON.stringify({
      result: {
        data: [
          {
            TRADE_DATE: `${recent} 00:00:00`,
            EXPLANATION: '换手率达20%',
            BUYER_OPERATEDEPT_NAME: '国泰君安上海江苏路',
          },
          {
            TRADE_DATE: `${recent} 00:00:00`,
            EXPLANATION: '换手率达20%', // duplicate reason, should not duplicate
            BUYER_OPERATEDEPT_NAME: '中信建投北京安立路',
            SELLER_OPERATEDEPT_NAME: '机构席位',
          },
        ],
      },
    });
    const fetchImpl: CnToolFetchLike = vi.fn(() =>
      Promise.resolve(fakeRes({ body })),
    );
    const tool = makeLhbScanCN({ fetchImpl });
    const result = await tool.run!(
      { symbol: '600519.SS', market: 'CN', ...wideWindow },
      ctx,
    );
    expect(result.data.appearances).toHaveLength(1);
    // plan-v2 Wave 1.4 — seat is now an object {name, buyAmount, sellAmount, netAmount};
    // the name-only legacy view is preserved on topBuySeatNames.
    expect(result.data.appearances[0].topBuySeatNames).toEqual([
      '国泰君安上海江苏路',
      '中信建投北京安立路',
    ]);
    expect(result.data.appearances[0].topSellSeatNames).toEqual(['机构席位']);
    expect(result.data.appearances[0].reason).toBe('换手率达20%');
  });

  it('filters out rows older than daysBack window', async () => {
    const ancient = new Date('2020-01-01').toISOString().slice(0, 10);
    const body = JSON.stringify({
      result: {
        data: [
          {
            TRADE_DATE: `${ancient} 00:00:00`,
            EXPLANATION: '某原因',
            BUYER_OPERATEDEPT_NAME: '某营业部',
          },
        ],
      },
    });
    const fetchImpl: CnToolFetchLike = vi.fn(() =>
      Promise.resolve(fakeRes({ body })),
    );
    const tool = makeLhbScanCN({ fetchImpl });
    const result = await tool.run!(
      { symbol: '600519.SS', market: 'CN', daysBack: 30 },
      ctx,
    );
    expect(result.data.appearances).toEqual([]);
  });

  it('throws retry-after on 429', async () => {
    const fetchImpl: CnToolFetchLike = vi.fn(() =>
      Promise.resolve(fakeRes({ ok: false, status: 429, body: '' })),
    );
    const tool = makeLhbScanCN({ fetchImpl });
    await expect(
      tool.run!({ symbol: '600519.SS', market: 'CN' }, ctx),
    ).rejects.toThrow(/retry-after/i);
  });

  it('caps each seat list at 5 entries', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const data = Array.from({ length: 7 }, (_, i) => ({
      TRADE_DATE: `${today} 00:00:00`,
      EXPLANATION: '某',
      BUYER_OPERATEDEPT_NAME: `seat-${i}`,
    }));
    const body = JSON.stringify({ result: { data } });
    const fetchImpl: CnToolFetchLike = vi.fn(() =>
      Promise.resolve(fakeRes({ body })),
    );
    const tool = makeLhbScanCN({ fetchImpl });
    const result = await tool.run!(
      { symbol: '600519.SS', market: 'CN', ...wideWindow },
      ctx,
    );
    expect(result.data.appearances[0].topBuySeats).toHaveLength(5);
  });

  it('extracts plan-v2 §5.1 day-level fields (deal ratio / free mcap / seat counts / multi-day follow-up / reason code)', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const body = JSON.stringify({
      result: {
        data: [
          {
            TRADE_DATE: `${today} 00:00:00`,
            EXPLANATION: '换手率达20%',
            EXPLAIN_TYPE: '007',
            BILLBOARD_DEAL_AMT_RATE: 38.5,
            FREE_MARKET_CAP: 1.23e10,
            BILLBOARD_BUY_NUM: 5,
            BILLBOARD_SELL_NUM: 3,
            D1_CLOSE_ADJCHRATE: 2.1,
            D2_CLOSE_ADJCHRATE: 1.5,
            D3_CLOSE_ADJCHRATE: -0.3,
            D5_CLOSE_ADJCHRATE: 4.2,
            D10_CLOSE_ADJCHRATE: 6.8,
            D20_CLOSE_ADJCHRATE: 9.1,
            BUYER_OPERATEDEPT_NAME: '游资营业部',
          },
        ],
      },
    });
    const fetchImpl: CnToolFetchLike = vi.fn(() => Promise.resolve(fakeRes({ body })));
    const tool = makeLhbScanCN({ fetchImpl });
    const r = await tool.run!(
      { symbol: '600519.SS', market: 'CN', ...wideWindow },
      ctx,
    );
    const a = r.data.appearances[0]!;
    expect(a.reasonCode).toBe('007');
    expect(a.billboardDealRatio).toBe(38.5);
    expect(a.freeMarketCap).toBe(1.23e10);
    expect(a.billboardBuyNum).toBe(5);
    expect(a.billboardSellNum).toBe(3);
    expect(a.changePctFollowing2d).toBe(1.5);
    expect(a.changePctFollowing3d).toBe(-0.3);
    expect(a.changePctFollowing20d).toBe(9.1);
  });

  it('flags institutional vs branded seats via IS_ORG + carries OPERATEDEPT_CODE', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const body = JSON.stringify({
      result: {
        data: [
          {
            TRADE_DATE: `${today} 00:00:00`,
            EXPLANATION: '日涨幅偏离值7%',
            BUYER_OPERATEDEPT_NAME: '机构席位',
            OPERATEDEPT_CODE: '',
            IS_ORG: 1,
          },
          {
            TRADE_DATE: `${today} 00:00:00`,
            EXPLANATION: '日涨幅偏离值7%',
            BUYER_OPERATEDEPT_NAME: '国泰君安上海江苏路',
            OPERATEDEPT_CODE: '20100101',
            IS_ORG: 0,
          },
        ],
      },
    });
    const fetchImpl: CnToolFetchLike = vi.fn(() => Promise.resolve(fakeRes({ body })));
    const tool = makeLhbScanCN({ fetchImpl });
    const r = await tool.run!(
      { symbol: '600519.SS', market: 'CN', ...wideWindow },
      ctx,
    );
    const seats = r.data.appearances[0]!.topBuySeats;
    const inst = seats.find((s) => s.name === '机构席位')!;
    const branded = seats.find((s) => s.name === '国泰君安上海江苏路')!;
    expect(inst.isInstitutional).toBe(true);
    expect(inst.code).toBe('');
    expect(branded.isInstitutional).toBe(false);
    expect(branded.code).toBe('20100101');
  });

  it('silently treats missing extra fields as null (legacy rows stay parseable)', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const body = JSON.stringify({
      result: {
        data: [
          {
            TRADE_DATE: `${today} 00:00:00`,
            EXPLANATION: '换手率达20%',
            BUYER_OPERATEDEPT_NAME: '某营业部',
          },
        ],
      },
    });
    const fetchImpl: CnToolFetchLike = vi.fn(() => Promise.resolve(fakeRes({ body })));
    const tool = makeLhbScanCN({ fetchImpl });
    const r = await tool.run!(
      { symbol: '600519.SS', market: 'CN', ...wideWindow },
      ctx,
    );
    const a = r.data.appearances[0]!;
    expect(a.reasonCode).toBeNull();
    expect(a.billboardDealRatio).toBeNull();
    expect(a.freeMarketCap).toBeNull();
    expect(a.changePctFollowing20d).toBeNull();
    expect(a.topBuySeats[0]?.isInstitutional).toBe(false);
    expect(a.topBuySeats[0]?.code).toBe('');
  });
});
