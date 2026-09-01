import { describe, expect, it, vi } from 'vitest';
import type { ScreeningQuery } from '@bourse/shared-types';
import type { FetchLike } from '../types';
import fixture from './__fixtures__/eastmoney-clist.json';
import {
  EASTMONEY_SCREENER_METRICS,
  createEastmoneyEquityScreenerConnector,
} from './eastmoney';

const BASE_QUERY: ScreeningQuery = {
  market: 'CN',
  universe: 'ACTIVE_COMMON_STOCKS',
  conditions: [{ metric: 'PRICE', operator: 'GTE', value: 0 }],
  sort: { metric: 'MARKET_CAP', direction: 'DESC' },
};

function jsonResponse(data: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
  };
}

describe('Eastmoney CN equity screener', () => {
  it('describes only the metrics the bulk endpoint can supply', async () => {
    const connector = createEastmoneyEquityScreenerConnector();

    const result = await connector.describe('CN');

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('expected descriptor');
    expect(result.data.metrics.map((item) => item.metric)).toEqual(EASTMONEY_SCREENER_METRICS);
    expect(result.data.metrics.map((item) => item.metric)).not.toContain('REVENUE_GROWTH_YOY');
    expect(result.data.sortableMetrics).toEqual(EASTMONEY_SCREENER_METRICS);
  });

  it('filters a full fixture and maps f115, not dynamic PE f9, to PE_TTM', async () => {
    const fetchLike = vi.fn<FetchLike>(async () => jsonResponse(fixture));
    const connector = createEastmoneyEquityScreenerConnector({ fetchLike });
    const query: ScreeningQuery = {
      ...BASE_QUERY,
      conditions: [
        { metric: 'MARKET_CAP', operator: 'GTE', value: 100_000_000_000 },
        { metric: 'PE_TTM', operator: 'BETWEEN', min: 5, max: 10 },
      ],
    };

    const result = await connector.screen(query);

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('expected snapshot');
    expect(result.data).toMatchObject({
      universeCount: 3,
      matchedCount: 1,
      providerAsOf: '2026-08-21T08:11:50.000Z',
      complete: true,
      truncated: false,
      conditionCounts: [2, 1],
    });
    expect(result.data.items[0]).toMatchObject({
      identityKey: 'CN:000001',
      exchange: 'SZSE',
      matchedConditionIndexes: [0, 1],
    });
    expect(result.data.items[0]?.metrics.PE_TTM?.value).toBe(8);
    expect(result.data.items[0]?.metrics.CHANGE_PCT?.value).toBeCloseTo(-0.011);
    expect(result.data.items[0]?.metrics.TURNOVER_RATE?.value).toBeCloseTo(0.024);
    expect(result.data.items[0]?.metrics.NET_INCOME_TTM?.status).toBe('MISSING');
    expect(result.data.items[0]?.metrics.PRICE?.asOf).toBe('2026-08-21T08:11:50.000Z');
    expect(result.freshness[0]).toMatchObject({
      asOf: '2026-08-21T08:11:50.000Z',
      stale: false,
    });
    expect(result.freshness[0]?.retrievedAt).not.toBe(result.freshness[0]?.asOf);
    expect(fetchLike).toHaveBeenCalledOnce();
    const url = new URL(fetchLike.mock.calls[0]![0]);
    expect(url.hostname).toBe('push2delay.eastmoney.com');
    expect(url.searchParams.get('fields')?.split(',')).toContain('f124');
  });

  it('rejects unsupported metrics without calling the upstream', async () => {
    const fetchLike = vi.fn<FetchLike>();
    const connector = createEastmoneyEquityScreenerConnector({ fetchLike });

    const result = await connector.screen({
      ...BASE_QUERY,
      conditions: [{ metric: 'REVENUE_GROWTH_YOY', operator: 'GTE', value: 10 }],
    });

    expect(result.status).toBe('failed');
    if (result.status !== 'failed') throw new Error('expected failure');
    expect(result.error?.code).toBe('UNSUPPORTED_REQUEST');
    expect(fetchLike).not.toHaveBeenCalled();
  });

  it('paginates the bulk snapshot and caps canonical results at 200', async () => {
    const rows = Array.from({ length: 205 }, (_, index) => ({
      f2: 10 + index,
      f3: 1,
      f8: 2,
      f9: 100 + index,
      f12: String(600_000 + index),
      f13: 1,
      f14: `样本 ${index}`,
      f20: 1_000_000_000 + index,
      f23: 1,
      f115: 10 + index,
      f124: 1_787_299_900 + index,
    }));
    const fetchLike = vi.fn<FetchLike>(async (input) => {
      const page = Number(new URL(input).searchParams.get('pn'));
      return jsonResponse({
        data: {
          total: rows.length,
          diff: page === 1 ? rows.slice(0, 150) : rows.slice(150),
        },
      });
    });
    const connector = createEastmoneyEquityScreenerConnector({ fetchLike });

    const result = await connector.screen(BASE_QUERY);

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('expected snapshot');
    expect(result.data.matchedCount).toBe(205);
    expect(result.data.items).toHaveLength(200);
    expect(result.data.truncated).toBe(true);
    expect(result.data.complete).toBe(true);
    expect(fetchLike).toHaveBeenCalledTimes(2);
    expect(fetchLike.mock.calls[0]?.[1]?.headers?.Referer).toContain('eastmoney.com');
  });

  it('keeps a legal first page as an explicitly partial single-source snapshot', async () => {
    const fetchLike = vi.fn<FetchLike>(async (input) => {
      const page = Number(new URL(input).searchParams.get('pn'));
      if (page === 2) return jsonResponse(null, 503);
      return jsonResponse({ data: { total: 5_000, diff: fixture.data.diff } });
    });
    const connector = createEastmoneyEquityScreenerConnector({ fetchLike });

    const result = await connector.screen(BASE_QUERY);

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('expected partial snapshot');
    expect(result.data.complete).toBe(false);
    expect(result.data.items).toHaveLength(3);
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: 'PARTIAL_COVERAGE' }));
  });

  it('keeps a row asOf null when its f124 is invalid', async () => {
    const validTime = 1_787_299_920;
    const rows = fixture.data.diff.slice(0, 2).map((row, index) => ({
      ...row,
      f124: index === 0 ? '-' : validTime,
    }));
    const fetchLike = vi.fn<FetchLike>(async () => jsonResponse({
      data: { total: rows.length, diff: rows },
    }));
    const connector = createEastmoneyEquityScreenerConnector({ fetchLike });

    const result = await connector.screen(BASE_QUERY);

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('expected snapshot');
    const expected = new Date(validTime * 1_000).toISOString();
    expect(result.data.providerAsOf).toBe(expected);
    expect(result.data.items.find((row) => row.symbol === '600001')?.metrics.PRICE?.asOf)
      .toBeNull();
    expect(result.data.items.find((row) => row.symbol === '000001')?.metrics.PRICE?.asOf)
      .toBe(expected);
  });

  it('fails rather than presenting retrieval time as provider time', async () => {
    const row = { ...fixture.data.diff[0], f124: '-' };
    const fetchLike = vi.fn<FetchLike>(async () => jsonResponse({
      data: { total: 1, diff: [row] },
    }));
    const connector = createEastmoneyEquityScreenerConnector({ fetchLike });

    const result = await connector.screen(BASE_QUERY);

    expect(result.status).toBe('failed');
    if (result.status !== 'failed') throw new Error('expected timestamp failure');
    expect(result.error?.code).toBe('VALIDATION_FAILED');
    expect(result.error?.message).toContain('provider timestamps');
  });

  it('fails when no valid page can be read', async () => {
    const fetchLike = vi.fn<FetchLike>(async () => jsonResponse({ data: null }));
    const connector = createEastmoneyEquityScreenerConnector({ fetchLike });

    const result = await connector.screen(BASE_QUERY);

    expect(result.status).toBe('failed');
    if (result.status !== 'failed') throw new Error('expected failure');
    expect(result.error?.code).toBe('VALIDATION_FAILED');
  });
});
