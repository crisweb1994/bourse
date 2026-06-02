import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../../../tools/types';
import { makeShareholdersCN } from '../../../tools/cn/shareholders';
import type { CnToolFetchLike } from '../../../tools/cn/_fetch-headers';

const ctx: ToolContext = {
  // The shareholders tool only reads `marketProfile` + `signal` off ctx.
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

describe('tools/cn/shareholders', () => {
  it('parses eastmoney RPT_F10_EH_HOLDERNUM response', async () => {
    const body = {
      success: true,
      result: {
        data: [
          {
            SECURITY_CODE: '600519',
            END_DATE: '2026-03-31 00:00:00',
            HOLDER_TOTAL_NUM: 242_750,
            HOLDER_TOTAL_NUMCHANGE: -13_220,
            CHANGEWITHLAST: -5.17,
            AVG_HOLD_AMT: 7_320_000,
            AVG_FREE_SHARES: 4500,
            HOLD_FOCUS: '集中',
          },
          {
            SECURITY_CODE: '600519',
            END_DATE: '2025-12-31 00:00:00',
            HOLDER_TOTAL_NUM: 255_970,
            HOLDER_TOTAL_NUMCHANGE: 1500,
            CHANGEWITHLAST: 0.59,
            AVG_HOLD_AMT: 6_900_000,
            AVG_FREE_SHARES: 4300,
            HOLD_FOCUS: '集中',
          },
        ],
      },
    };
    const fetchImpl: CnToolFetchLike = vi.fn(() =>
      Promise.resolve(fakeRes({ body })),
    );
    const tool = makeShareholdersCN({ fetchImpl });
    const result = await tool.run!(
      { symbol: '600519.SS', market: 'CN', quartersBack: 4 },
      ctx,
    );

    expect(result.data.rows).toHaveLength(2);
    expect(result.data.rows[0]!.endDate).toBe('2026-03-31');
    expect(result.data.rows[0]!.holderTotalNum).toBe(242_750);
    expect(result.data.rows[0]!.holderTotalNumChange).toBe(-13_220);
    expect(result.data.rows[0]!.holderTotalNumChangePct).toBeCloseTo(-0.0517, 4);
    expect(result.data.rows[0]!.avgHoldAmount).toBeCloseTo(7_320_000);
    expect(result.data.rows[0]!.concentrationLabel).toBe('集中');
    expect(result.data.latestTrend).toBe('falling');
    expect(result.citations[0]?.title).toContain('股东户数');
  });

  it('caps results at quartersBack even when API returns more', async () => {
    const rows = Array.from({ length: 8 }, (_, i) => ({
      SECURITY_CODE: '600519',
      END_DATE: `2025-0${(i % 9) + 1}-30 00:00:00`,
      HOLDER_TOTAL_NUM: 200_000 + i * 1000,
      HOLDER_TOTAL_NUMCHANGE: 1000,
      CHANGEWITHLAST: 0.5,
      AVG_HOLD_AMT: 100_000,
      AVG_FREE_SHARES: 4000,
      HOLD_FOCUS: '分散',
    }));
    const fetchImpl: CnToolFetchLike = vi.fn(() =>
      Promise.resolve(fakeRes({ body: { result: { data: rows } } })),
    );
    const tool = makeShareholdersCN({ fetchImpl });
    const result = await tool.run!(
      { symbol: '600519.SS', market: 'CN', quartersBack: 4 },
      ctx,
    );
    expect(result.data.rows).toHaveLength(4);
  });

  it('returns empty rows + unknown trend when API returns no data array', async () => {
    const fetchImpl: CnToolFetchLike = vi.fn(() =>
      Promise.resolve(fakeRes({ body: { result: {} } })),
    );
    const tool = makeShareholdersCN({ fetchImpl });
    const result = await tool.run!({ symbol: '600519.SS', market: 'CN' }, ctx);
    expect(result.data.rows).toEqual([]);
    expect(result.data.latestTrend).toBe('unknown');
  });

  it('throws when Eastmoney returns code=9501 (report config not found)', async () => {
    const fetchImpl: CnToolFetchLike = vi.fn(() =>
      Promise.resolve(fakeRes({ body: { code: 9501, message: 'config gone' } })),
    );
    const tool = makeShareholdersCN({ fetchImpl });
    await expect(
      tool.run!({ symbol: '600519.SS', market: 'CN' }, ctx),
    ).rejects.toThrow(/report config not found/);
  });

  it('throws retry-after on 429', async () => {
    const fetchImpl: CnToolFetchLike = vi.fn(() =>
      Promise.resolve({
        ok: false,
        status: 429,
        text: () => Promise.resolve(''),
        json: () => Promise.resolve({}),
      }),
    );
    const tool = makeShareholdersCN({ fetchImpl });
    await expect(
      tool.run!({ symbol: '600519.SS', market: 'CN' }, ctx),
    ).rejects.toThrow(/retry-after/);
  });

  it('tolerates string-encoded numerics from Eastmoney', async () => {
    const body = {
      result: {
        data: [
          {
            SECURITY_CODE: '600519',
            END_DATE: '2026-03-31',
            HOLDER_TOTAL_NUM: '242750',
            HOLDER_TOTAL_NUMCHANGE: '-13220',
            CHANGEWITHLAST: '-5.17',
            AVG_HOLD_AMT: '7320000',
            AVG_FREE_SHARES: '-',
            HOLD_FOCUS: null,
          },
        ],
      },
    };
    const fetchImpl: CnToolFetchLike = vi.fn(() => Promise.resolve(fakeRes({ body })));
    const tool = makeShareholdersCN({ fetchImpl });
    const result = await tool.run!({ symbol: '600519.SS', market: 'CN' }, ctx);
    expect(result.data.rows[0]!.holderTotalNum).toBe(242_750);
    expect(result.data.rows[0]!.avgHoldShares).toBeNull(); // "-" sentinel
    expect(result.data.rows[0]!.concentrationLabel).toBeNull();
  });
});
