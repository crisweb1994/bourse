import { describe, expect, it, vi } from 'vitest';
import { createEastmoneyHkProfileConnector } from './eastmoney-hk-profile';
import type { FetchLike } from '../types';

function response(data: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
    text: async () => JSON.stringify(data),
  };
}

describe('Eastmoney HK company profile', () => {
  it('normalizes the HK code and parses useful profile fields', async () => {
    const fetchLike: FetchLike = vi.fn(async () => response({
      code: 0,
      result: {
        data: [{
          BELONG_INDUSTRY: '软件服务',
          EMP_NUM: 87412,
          ORG_WEB: 'www.tencent.com',
          ORG_PROFILE: '  腾讯控股是一家互联网科技公司。 ',
        }],
      },
    }));
    const connector = createEastmoneyHkProfileConnector({
      fetchLike,
      now: () => new Date('2026-07-28T00:00:00.000Z'),
    });

    const result = await connector.getProfile({ instrumentId: 'HK:0700' });

    expect(result.data).toMatchObject({
      instrument: {
        instrumentId: 'HK:0700',
        market: 'HK',
        symbol: '0700',
        currency: 'HKD',
        providerSymbols: { eastmoney: '00700.HK' },
      },
      description: '腾讯控股是一家互联网科技公司。',
      industry: '软件服务',
      employees: 87412,
      website: 'www.tencent.com',
    });
    expect(result.citations[0]?.provider).toBe('eastmoney-hk-profile');
    expect(String(vi.mocked(fetchLike).mock.calls[0]?.[0])).toContain('RPT_HKF10_INFO_ORGPROFILE');
    expect(decodeURIComponent(String(vi.mocked(fetchLike).mock.calls[0]?.[0]))).toContain('SECUCODE="00700.HK"');
  });

  it('returns a warning envelope when the report has no row', async () => {
    const connector = createEastmoneyHkProfileConnector({
      fetchLike: async () => response({ code: 9201, result: null }),
    });

    const result = await connector.getProfile({ instrumentId: 'HK:9999' });

    expect(result.data.instrument.instrumentId).toBe('HK:9999');
    expect(result.warnings[0]?.code).toBe('PARTIAL_DATA');
  });

  it('rejects non-HK instruments without fetching', async () => {
    const fetchLike: FetchLike = vi.fn(async () => response({}));
    const connector = createEastmoneyHkProfileConnector({ fetchLike });

    const result = await connector.getProfile({ instrumentId: 'US:AAPL' });

    expect(result.warnings[0]?.code).toBe('UNSUPPORTED_MARKET');
    expect(fetchLike).not.toHaveBeenCalled();
  });
});
