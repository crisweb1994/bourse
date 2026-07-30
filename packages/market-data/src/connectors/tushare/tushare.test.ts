import { describe, expect, it, vi } from 'vitest';
import { createMarketData } from '../../client';
import { createTushareSourcePlugin, parseTushareDataSets } from './index';
import type { FetchLike } from '../types';

function response(payload: unknown): Awaited<ReturnType<FetchLike>> {
  return { ok: true, status: 200, json: async () => payload };
}

describe('Tushare Pro source plugin', () => {
  it('projects configured entitlements into the effective manifest', () => {
    const instance = createTushareSourcePlugin().create({
      token: 'secret-token',
      enabledDataSets: ['dividend', 'shareholder-count'],
      requestsPerMinute: 120,
    }, {});

    expect(instance.manifest.capabilities).toEqual([
      expect.objectContaining({ capability: 'corporate-actions', dataSets: ['dividend'] }),
      expect.objectContaining({ capability: 'ownership', dataSets: ['shareholder-count'] }),
    ]);
    expect(instance.manifest.rateLimit).toMatchObject({ maxRequests: 120, windowMs: 60_000 });
    expect(instance.credentialScope).toMatch(/^credential:tushare-[a-f0-9]{16}$/);
    expect(instance.credentialScope).not.toContain('secret-token');
  });

  it('routes a dividend request and normalizes the vendor row', async () => {
    let body: Record<string, unknown> | undefined;
    const fetchLike: FetchLike = vi.fn(async (_url, init) => {
      body = JSON.parse(init?.body ?? '{}') as Record<string, unknown>;
      return response({
        code: 0,
        msg: null,
        data: {
          fields: ['ts_code', 'ann_date', 'div_proc', 'stk_div', 'cash_div_tax', 'record_date', 'ex_date', 'pay_date'],
          items: [['600519.SH', '20260401', '实施', 2, 25.9, '20260601', '20260602', '20260603']],
        },
      });
    });
    const client = createMarketData({
      tushare: { token: 'test-token', enabledDataSets: ['dividend'], fetchLike },
    });

    const result = await client.getCorporateActions({ instrumentId: 'CN:600519', dataSet: 'dividend' });

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.trace.selectedSource).toBe('tushare-pro');
    expect(result.data[0]).toMatchObject({
      instrumentId: 'CN:600519',
      type: 'DIVIDEND',
      status: 'COMPLETED',
      cashAmount: '25.9',
      currency: 'CNY',
      exDate: '2026-06-02',
    });
    expect(body).toMatchObject({ api_name: 'dividend', token: 'test-token', params: { ts_code: '600519.SH' } });
  });

  it('classifies an entitlement rejection without returning an empty success', async () => {
    const fetchLike: FetchLike = vi.fn(async () => response({ code: -2001, msg: '抱歉，您没有访问该接口的权限', data: null }));
    const client = createMarketData({
      tushare: { token: 'test-token', enabledDataSets: ['margin'], fetchLike },
    });
    const result = await client.getOwnership({ instrumentId: 'CN:600519', dataSet: 'margin' });
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') return;
    expect(result.error?.code).toBe('PERMISSION_DENIED');
  });

  it('parses only explicitly supported data sets', () => {
    expect(parseTushareDataSets(' dividend,margin,unknown,dividend ')).toEqual(['dividend', 'margin']);
  });
});
