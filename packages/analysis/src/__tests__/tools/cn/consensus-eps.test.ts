import { describe, expect, it, vi } from 'vitest';
import { CN } from '../../../markets/cn';
import { makeConsensusEpsCN } from '../../../tools/cn/consensus-eps';
import type { CnToolFetchLike } from '../../../tools/cn/_fetch-headers';

function fakeRes(opts: { ok?: boolean; status?: number; body: string }) {
  return {
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    text: () => Promise.resolve(opts.body),
  };
}

const ctx = { marketProfile: CN };

describe('tools/cn/consensusEps', () => {
  it('code 9201 / empty → graceful empty forecasts, not a throw', async () => {
    const body = JSON.stringify({
      result: null,
      success: false,
      message: '返回数据为空',
      code: 9201,
    });
    const fetchImpl: CnToolFetchLike = vi.fn(() =>
      Promise.resolve(fakeRes({ body })),
    );
    const tool = makeConsensusEpsCN({ fetchImpl });
    const result = await tool.run!({ symbol: '600519.SS', market: 'CN' }, ctx);
    expect(result.data.forecasts).toHaveLength(0);
  });

  it('parses yearly forecasts and sorts ascending', async () => {
    const body = JSON.stringify({
      result: {
        // RPT_WEB_RESPREDICT: single row, YEARn/EPSn columns (out of order
        // here to exercise the ascending sort).
        data: [
          { YEAR1: 2027, EPS1: 6.2, YEAR2: 2025, EPS2: 4.8, YEAR3: 2026, EPS3: 5.5 },
        ],
      },
    });
    const fetchImpl: CnToolFetchLike = vi.fn(() =>
      Promise.resolve(fakeRes({ body })),
    );
    const tool = makeConsensusEpsCN({ fetchImpl });
    const result = await tool.run!(
      { symbol: '600519.SS', market: 'CN' },
      ctx,
    );
    expect(result.data.forecasts).toEqual([
      { year: 2025, value: 4.8 },
      { year: 2026, value: 5.5 },
      { year: 2027, value: 6.2 },
    ]);
    expect(result.trace?.source).toBe('eastmoney');
  });

  it('skips rows with missing year or EPS', async () => {
    const body = JSON.stringify({
      result: {
        // YEAR2 missing, EPS3 missing → only the YEAR1/EPS1 pair survives.
        data: [{ YEAR1: 2026, EPS1: 5.5, EPS2: 6.0, YEAR3: 2027 }],
      },
    });
    const fetchImpl: CnToolFetchLike = vi.fn(() =>
      Promise.resolve(fakeRes({ body })),
    );
    const tool = makeConsensusEpsCN({ fetchImpl });
    const result = await tool.run!(
      { symbol: '600519.SS', market: 'CN' },
      ctx,
    );
    expect(result.data.forecasts).toHaveLength(1);
  });

  it('throws retry-after on 429', async () => {
    const fetchImpl: CnToolFetchLike = vi.fn(() =>
      Promise.resolve(fakeRes({ ok: false, status: 429, body: '' })),
    );
    const tool = makeConsensusEpsCN({ fetchImpl });
    await expect(
      tool.run!({ symbol: '600519.SS', market: 'CN' }, ctx),
    ).rejects.toThrow(/retry-after/i);
  });

  it('exhausts sources when eastmoney + thsNorthbound both unavailable', async () => {
    const fetchImpl: CnToolFetchLike = vi.fn(() =>
      Promise.resolve(fakeRes({ ok: false, status: 500, body: '' })),
    );
    const tool = makeConsensusEpsCN({ fetchImpl });
    await expect(
      tool.run!({ symbol: '600519.SS', market: 'CN' }, ctx),
    ).rejects.toThrow(/exhausted/);
    // eastmoney HTTP attempted; thsNorthbound throws sync (no HTTP)
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('throws when no parseable rows', async () => {
    const body = JSON.stringify({ result: { data: [{}] } });
    const fetchImpl: CnToolFetchLike = vi.fn(() =>
      Promise.resolve(fakeRes({ body })),
    );
    const tool = makeConsensusEpsCN({ fetchImpl });
    await expect(
      tool.run!({ symbol: '600519.SS', market: 'CN' }, ctx),
    ).rejects.toThrow(/no parseable|exhausted/i);
  });
});
