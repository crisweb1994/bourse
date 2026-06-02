import { describe, expect, it } from 'vitest';
import type { FetchLike } from '../types';
import { classifyFilingTitle, createCnFilingsConnector } from './cn';

function cninfoOk(announcements: Array<Record<string, unknown>>): FetchLike {
  return async (url) => {
    if (!url.includes('cninfo.com.cn')) {
      return { ok: false, status: 404, json: async () => ({}) };
    }
    return { ok: true, status: 200, json: async () => ({ announcements }) };
  };
}

function fail(status: number): FetchLike {
  return async () => ({ ok: false, status, json: async () => ({}) });
}

const MOUTAI_ITEMS = [
  {
    announcementTitle: '贵州茅台:2025年年度报告',
    adjunctUrl: 'finalpage/2026-01-15/600519_2025.PDF',
    announcementTime: 1736899200000, // 2025-01-15
  },
  {
    announcementTitle: '贵州茅台:2026年第一季度报告',
    adjunctUrl: 'finalpage/2026-04-25/600519_Q1.PDF',
    announcementTime: 1745539200000,
  },
  {
    announcementTitle: '贵州茅台:关于召开股东大会的公告',
    adjunctUrl: 'finalpage/2026-04-10/600519_extra.PDF',
    announcementTime: 1744243200000,
  },
];

describe('cn-filings connector — searchFilings', () => {
  it('parses cninfo announcements into FilingSummary[] with tier=A citations', async () => {
    const c = createCnFilingsConnector();
    const out = await c.searchFilings(
      { instrumentId: 'CN:600519' },
      { fetchLike: cninfoOk(MOUTAI_ITEMS) },
    );
    expect(out.schemaVersion).toBe('1.0');
    expect(out.data).toHaveLength(3);
    expect(out.data[0]).toMatchObject({
      instrumentId: 'CN:600519',
      provider: 'cninfo',
    });
    expect(out.data[0].id.length).toBe(64); // sha256 hex
    expect(out.data[0].formType).toBe('annual');
    expect(out.data[0].filingUrl).toContain('static.cninfo.com.cn');
    expect(out.citations[0].qualityTier).toBe('A');
    expect(out.citations[0].sourceType).toBe('FILING');
    expect(out.warnings).toHaveLength(0);
  });

  it('filters by forms[]', async () => {
    const c = createCnFilingsConnector();
    const out = await c.searchFilings(
      { instrumentId: 'CN:600519', forms: ['annual'] },
      { fetchLike: cninfoOk(MOUTAI_ITEMS) },
    );
    expect(out.data).toHaveLength(1);
    expect(out.data[0].formType).toBe('annual');
  });

  it('falls back to eastmoney when cninfo fails', async () => {
    const fetchLike: FetchLike = async (url) => {
      if (url.includes('cninfo.com.cn')) {
        return { ok: false, status: 500, json: async () => ({}) };
      }
      // eastmoney
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            list: [
              {
                title: '贵州茅台:2025年年度报告',
                art_code: 'AN2026000123',
                notice_date: '2026-01-15',
              },
            ],
          },
        }),
      };
    };
    const c = createCnFilingsConnector();
    const out = await c.searchFilings({ instrumentId: 'CN:600519' }, { fetchLike });
    expect(out.data[0].provider).toBe('eastmoney');
    expect(out.data[0].filingUrl).toContain('pdf.dfcfw.com');
    expect(out.warnings.some((w) => w.provider === 'cninfo')).toBe(true);
  });

  it('429 surfaces RATE_LIMITED with retryAfterMs', async () => {
    const c = createCnFilingsConnector({ sources: ['cninfo'] });
    const out = await c.searchFilings({ instrumentId: 'CN:600519' }, { fetchLike: fail(429) });
    const rate = out.warnings.find((w) => w.code === 'RATE_LIMITED');
    expect(rate).toBeDefined();
    expect(rate?.retryAfterMs).toBeGreaterThan(0);
  });

  it('rejects non-CN markets', async () => {
    const c = createCnFilingsConnector();
    const out = await c.searchFilings({ instrumentId: 'US:NVDA' }, { fetchLike: fail(200) });
    expect(out.warnings[0].code).toBe('UNSUPPORTED_MARKET');
  });

  it('returns INVALID_INSTRUMENT for symbols outside known A-share prefixes', async () => {
    const c = createCnFilingsConnector();
    const out = await c.searchFilings({ instrumentId: 'CN:999999' }, { fetchLike: fail(200) });
    expect(out.warnings[0].code).toBe('INVALID_INSTRUMENT');
  });

  it('emits SOURCE_UNAVAILABLE when all sources exhausted', async () => {
    const c = createCnFilingsConnector();
    const out = await c.searchFilings({ instrumentId: 'CN:600519' }, { fetchLike: fail(503) });
    expect(out.warnings.some((w) => /exhausted/.test(w.message))).toBe(true);
  });

  it('getFiling stub returns PARTIAL_DATA', async () => {
    const out = await createCnFilingsConnector().getFiling!({ id: 'anything' });
    expect(out.warnings[0].code).toBe('PARTIAL_DATA');
  });
});

describe('classifyFilingTitle', () => {
  it('classifies common A-share titles', () => {
    expect(classifyFilingTitle('贵州茅台:2025年年度报告')).toBe('annual');
    expect(classifyFilingTitle('2026年第一季度报告')).toBe('quarterly');
    expect(classifyFilingTitle('2025年半年度报告')).toBe('semiannual');
    expect(classifyFilingTitle('业绩预告')).toBe('preview');
    expect(classifyFilingTitle('业绩快报')).toBe('preliminary');
    expect(classifyFilingTitle('关于召开股东大会的公告')).toBe('extraordinary');
    expect(classifyFilingTitle('随便一个标题')).toBe('other');
  });
});
