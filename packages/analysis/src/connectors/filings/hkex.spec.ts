import { describe, expect, it } from 'vitest';
import type { FetchLike } from '../types';
import { classifyHkexFiling, createHkexFilingsConnector, inferHkPeriodEndOn } from './hkex';

describe('HKEX filings connector', () => {
  it('groups Chinese and English variants and filters earnings forms', async () => {
    const fetchLike: FetchLike = async (url) => {
      if (url.includes('/search/prefix.do')) {
        return textResponse('callback({"stockInfo":[{"stockId":7609,"code":"00700"}]});');
      }
      const chinese = url.includes('lang=zh');
      return jsonResponse({
        result: JSON.stringify([{
          NEWS_ID: chinese ? 'zh-1' : 'en-1',
          TITLE: chinese ? '截至2025年12月31日止年度全年業績公告' : 'ANNUAL RESULTS ANNOUNCEMENT FOR THE YEAR ENDED 31 DECEMBER 2025',
          DATE_TIME: '18/03/2026 12:30',
          FILE_LINK: chinese ? '/listedco/zh.pdf' : '/listedco/en.pdf',
          FILE_TYPE: 'PDF',
        }]),
      });
    };
    const result = await createHkexFilingsConnector({
      fetchLike,
      now: () => new Date('2026-07-23T00:00:00.000Z'),
    }).searchFilings({
      instrumentId: 'HK:0700',
      forms: ['preliminary'],
      limit: 10,
    });
    expect(result.data).toHaveLength(2);
    expect(result.data.map((item) => item.language).sort()).toEqual(['en-HK', 'zh-HK']);
    expect(new Set(result.data.map((item) => item.sourceGroupId)).size).toBe(1);
    expect(result.data[0].periodEndOn).toBe('2025-12-31');
  });

  it('rejects non-HK instruments without upstream access', async () => {
    let calls = 0;
    const result = await createHkexFilingsConnector({
      fetchLike: async () => {
        calls += 1;
        return jsonResponse({});
      },
    }).searchFilings({ instrumentId: 'US:AAPL' });
    expect(result.data).toEqual([]);
    expect(calls).toBe(0);
    expect(result.warnings[0]?.code).toBe('UNSUPPORTED_MARKET');
  });

  it('rejects a filing redirected outside the trusted HKEX hosts', async () => {
    const result = await createHkexFilingsConnector({
      fetchLike: async () => ({
        ok: true,
        status: 200,
        url: 'https://example.com/untrusted.pdf',
        json: async () => ({}),
        arrayBuffer: async () => new ArrayBuffer(0),
      }),
    }).getFiling!({
      id: 'filing-1',
      filingUrl: 'https://www1.hkexnews.hk/listedco/listconews/sehk/2026/0723/report.pdf',
    });
    expect(result.warnings[0]?.message).toContain('untrusted host');
  });
});

describe('HKEX filing classification', () => {
  it('classifies supported result types', () => {
    expect(classifyHkexFiling('PROFIT WARNING')).toBe('profit_warning');
    expect(classifyHkexFiling('中期業績公告')).toBe('preliminary');
    expect(classifyHkexFiling('ANNUAL REPORT 2025')).toBe('annual');
    expect(classifyHkexFiling('Next Day Disclosure Return')).toBe('other');
  });

  it('infers explicit English and numeric Chinese periods', () => {
    expect(inferHkPeriodEndOn('RESULTS FOR THE YEAR ENDED 31 DECEMBER 2025')).toBe('2025-12-31');
    expect(inferHkPeriodEndOn('截至2025年6月30日止六個月')).toBe('2025-06-30');
  });
});

function textResponse(value: string) {
  return {
    ok: true,
    status: 200,
    json: async () => JSON.parse(value),
    text: async () => value,
  };
}

function jsonResponse(value: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => value,
    text: async () => JSON.stringify(value),
  };
}
