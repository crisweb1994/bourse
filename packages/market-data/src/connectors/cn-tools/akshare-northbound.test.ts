import { describe, expect, it } from 'vitest';
import {
  akshareNorthboundCN,
  makeAkshareNorthboundCN,
} from './akshare-northbound';
import type { CnToolFetchLike } from './_fetch-headers';

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

const fakeFetch = (payload: unknown): CnToolFetchLike => (_url, _init) =>
  Promise.resolve(jsonResponse(payload));

function getToolRun(tool: ReturnType<typeof makeAkshareNorthboundCN>) {
  if (!tool.run) throw new Error('akshareNorthbound test tool has no run implementation');
  return tool.run;
}

describe('akshare-northbound — 2026-08 Eastmoney schema (TRADE_DATE)', () => {
  it('buildUrl sorts by TRADE_DATE (HOLD_DATE was retired)', () => {
    const seenUrls: string[] = [];
    const fetchImpl: CnToolFetchLike = (url) => {
      seenUrls.push(String(url));
      return Promise.resolve(
        jsonResponse({ result: { data: [] }, success: false, code: 9501 }),
      );
    };
    const tool = makeAkshareNorthboundCN({ fetchImpl });
    // All mirrors fail → tool throws; we only care about mirror 1's URL.
    const run = getToolRun(tool);
    return run(
        { symbol: '600519.SS', market: 'CN' },
        { market: 'CN', todayDate: '2026-08-15' } as never,
      )
      .catch(() => undefined)
      .then(() => {
        expect(seenUrls[0]).toContain('sortColumns=TRADE_DATE');
      });
  });

  it('parses the new payload: TRADE_DATE + raw-share units normalized', async () => {
    const tool = makeAkshareNorthboundCN({
      fetchImpl: fakeFetch({
        result: {
          data: [
            {
              TRADE_DATE: '2026-06-30 00:00:00',
              MUTUAL_TYPE: '001',
              HOLD_SHARES: 53711656, // raw shares
              HOLD_MARKET_CAP: 63674631071.44, // CNY yuan
              FREE_SHARES_RATIO: 4.2967, // percent
              TOTAL_SHARES_RATIO: 4.2967,
              HOLD_MARKETCAP_CHG1: null,
            },
          ],
        },
      }),
    });
    const result = await getToolRun(tool)(
      { symbol: '600519.SS', market: 'CN' },
      { market: 'CN', todayDate: '2026-08-15' } as never,
    );
    // 稀疏持股行如实保留；普通个股资金流不是北向流，不能混入。
    expect(result.data.sourceMirror).toBe('eastmoney-datacenter');
    expect(result.data.rows).toHaveLength(1);
    const row = result.data.rows[0]!;
    expect(row.date).toBe('2026-06-30');
    // 股 → 万股
    expect(row.holdShares).toBeCloseTo(5371.1656, 3);
    // 元 → 亿元
    expect(row.holdMarketValue).toBeCloseTo(636.7463, 3);
    // percent → decimal
    expect(row.holdPctOfFloat).toBeCloseTo(0.042967, 6);
    // No flow columns survive → flows are 0, holding data keeps the row alive
    expect(row.hgt).toBe(0);
    expect(row.sgt).toBe(0);
  });

  it('still parses the legacy payload (HOLD_DATE/ADD_MARKET_CAP) for cached sources', async () => {
    const tool = makeAkshareNorthboundCN({
      fetchImpl: fakeFetch({
        result: {
          data: [
            {
              HOLD_DATE: '2026-05-02 00:00:00',
              MUTUAL_TYPE: '1',
              ADD_MARKET_CAP: 12.5, // 亿元 (legacy unit)
              HOLD_SHARES_NUM: 5300.0, // 万股 (legacy unit)
              SHARES_HOLDRATIO: 4.2,
            },
          ],
        },
      }),
    });
    const result = await getToolRun(tool)(
      { symbol: '600519.SS', market: 'CN' },
      { market: 'CN', todayDate: '2026-08-15' } as never,
    );
    const row = result.data.rows[0]!;
    expect(row.date).toBe('2026-05-02');
    expect(row.hgt).toBe(12.5);
    expect(row.holdShares).toBe(5300);
    expect(row.holdPctOfFloat).toBeCloseTo(0.042, 6);
  });

  it('drops rows with neither flow nor holding data', async () => {
    const tool = makeAkshareNorthboundCN({
      fetchImpl: fakeFetch({
        result: {
          data: [
            {
              TRADE_DATE: '2026-06-30 00:00:00',
              MUTUAL_TYPE: '001',
              HOLD_SHARES: null,
              HOLD_MARKET_CAP: null,
              HOLD_MARKETCAP_CHG1: null,
            },
          ],
        },
      }),
      // Second mirror also empty so the tool surfaces not_implemented.
      mirrors: undefined,
    });
    await expect(
      getToolRun(tool)({ symbol: '600519.SS', market: 'CN' }, { market: 'CN', todayDate: '2026-08-15' } as never),
    ).rejects.toThrow(/all mirrors failed/);
  });

  it('default export remains wired', () => {
    expect(akshareNorthboundCN.name).toBe('akshareNorthbound');
  });
});

describe('akshare-northbound — source semantics', () => {
  it('does not fall back to generic individual-stock fund flow', async () => {
    let calls = 0;
    const fetchImpl: CnToolFetchLike = () => {
      calls += 1;
      return Promise.resolve(jsonResponse({
        result: {
          data: [{
            TRADE_DATE: '2026-06-30 00:00:00',
            MUTUAL_TYPE: '001',
            HOLD_SHARES: 53711656,
            HOLD_MARKET_CAP: 63674631071.44,
            FREE_SHARES_RATIO: 4.2967,
          }],
        },
      }));
    };
    const tool = makeAkshareNorthboundCN({ fetchImpl });
    const result = await getToolRun(tool)(
      { symbol: '600519.SS', market: 'CN' },
      { market: 'CN', todayDate: '2026-08-15' } as never,
    );
    expect(calls).toBe(1);
    expect(result.data.sourceMirror).toBe('eastmoney-datacenter');
    expect(result.data.rows).toHaveLength(1);
    expect(result.data.rows[0]!.holdPctOfFloat).toBeCloseTo(0.042967, 6);
  });
});
