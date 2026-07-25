import { describe, expect, it } from 'vitest';
import type { FetchLike } from '../types';
import { classifyFilingTitle, createCnFilingsConnector, inferCnPeriodEndOn } from './cn';

function cninfoOk(announcements: Array<Record<string, unknown>>): FetchLike {
  return async (url, init) => {
    if (!url.includes('cninfo.com.cn')) {
      return { ok: false, status: 404, json: async () => ({}) };
    }
    if (url.includes('topSearch/query')) {
      return {
        ok: true,
        status: 200,
        json: async () => [{ code: '600519', orgId: 'gssh0600519' }],
      };
    }
    expect(String(init?.body)).toContain('stock=600519%2Cgssh0600519');
    return { ok: true, status: 200, json: async () => ({ announcements }) };
  };
}

function fail(status: number): FetchLike {
  return async () => ({ ok: false, status, json: async () => ({}) });
}

const MOUTAI_ITEMS = [
  {
    announcementId: 'AN-CNINFO-1',
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
      sourceDocumentId: 'AN-CNINFO-1',
    });
    expect(out.data[0].id.length).toBe(64); // sha256 hex
    expect(out.data[0].formType).toBe('annual');
    expect(out.data[0].periodEndOn).toBe('2025-12-31');
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

  it('searches a wider source window before filtering requested forms', async () => {
    const fetchLike: FetchLike = async (url) => {
      if (url.includes('topSearch/query')) {
        return { ok: true, status: 200, json: async () => [{ code: '600519', orgId: 'gssh0600519' }] };
      }
      if (url.includes('cninfo.com.cn')) {
        expect(url).toContain('hisAnnouncement/query');
        return {
          ok: true,
          status: 200,
          json: async () => ({ announcements: MOUTAI_ITEMS }),
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    };
    const c = createCnFilingsConnector();
    const out = await c.searchFilings(
      { instrumentId: 'CN:600519', forms: ['quarterly'], limit: 1 },
      { fetchLike },
    );
    expect(out.data).toHaveLength(1);
    expect(out.data[0].formType).toBe('quarterly');
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

  it('falls back when cninfo has no requested report type and filters eastmoney after a wide fetch', async () => {
    const ordinary = Array.from({ length: 20 }, (_, index) => ({
      title: `贵州茅台:普通公告${index}`,
      art_code: `AN-OTHER-${index}`,
      notice_date: '2026-07-01',
    }));
    const fetchLike: FetchLike = async (url) => {
      if (url.includes('topSearch/query')) {
        return { ok: true, status: 200, json: async () => [{ code: '600519', orgId: 'gssh0600519' }] };
      }
      if (url.includes('cninfo.com.cn')) {
        return { ok: true, status: 200, json: async () => ({ announcements: [MOUTAI_ITEMS[2]] }) };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            list: [...ordinary, {
              title: '贵州茅台:2026年第一季度报告',
              art_code: 'AN-Q1-2026',
              notice_date: '2026-04-25',
            }],
          },
        }),
      };
    };
    const c = createCnFilingsConnector();
    const out = await c.searchFilings(
      { instrumentId: 'CN:600519', forms: ['quarterly'], limit: 1 },
      { fetchLike },
    );
    expect(out.data).toHaveLength(1);
    expect(out.data[0]).toMatchObject({ provider: 'eastmoney', formType: 'quarterly' });
    expect(out.warnings.some((warning) => warning.provider === 'cninfo')).toBe(true);
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

  it('getFiling rejects untrusted URLs', async () => {
    const out = await createCnFilingsConnector().getFiling!({ id: 'anything' });
    expect(out.warnings[0].code).toBe('INVALID_INSTRUMENT');
  });

  it('downloads and parses a trusted PDF artifact', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const fetchLike: FetchLike = async () => ({
      ok: true,
      status: 200,
      json: async () => ({}),
      arrayBuffer: async () => bytes.buffer,
    });
    const c = createCnFilingsConnector({
      fetchLike,
      pdfParser: async () => ({
        text: '营业收入 100 亿元',
        pages: [{ page: 1, text: '营业收入 100 亿元', startOffset: 0, endOffset: 12 }],
      }),
    });
    const out = await c.getFiling!({
      id: 'id-1',
      sourceDocumentId: 'announcement-1',
      instrumentId: 'CN:600519',
      formType: 'preliminary',
      filingUrl: 'https://static.cninfo.com.cn/finalpage/report.pdf',
      provider: 'cninfo',
    });
    expect(out.warnings).toEqual([]);
    expect(out.data.text).toContain('100');
    expect(out.data.rawContent).toEqual(bytes);
    expect(out.data.pages?.[0].page).toBe(1);
    expect(out.data.contentHash).toHaveLength(64);
  });

  it('hashes raw PDF bytes before a parser can detach the input buffer', async () => {
    const source = new Uint8Array([37, 80, 68, 70]);
    const fetchLike: FetchLike = async () => ({
      ok: true,
      status: 200,
      json: async () => ({}),
      arrayBuffer: async () => source.slice().buffer,
    });
    const c = createCnFilingsConnector({
      fetchLike,
      pdfParser: async (bytes) => {
        structuredClone(bytes.buffer, { transfer: [bytes.buffer] });
        return {
          text: '营业收入 100 亿元',
          pages: [{ page: 1, text: '营业收入 100 亿元', startOffset: 0, endOffset: 12 }],
        };
      },
    });
    const out = await c.getFiling!({
      id: 'id-detached',
      sourceDocumentId: 'announcement-detached',
      instrumentId: 'CN:600519',
      formType: 'quarterly',
      filingUrl: 'https://static.cninfo.com.cn/finalpage/report.pdf',
      provider: 'cninfo',
    });
    expect(out.warnings).toEqual([]);
    expect(out.data.contentHash).toHaveLength(64);
    expect(out.data.rawContent).toEqual(source);
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

  it('infers only unambiguous A-share period ends', () => {
    expect(inferCnPeriodEndOn('贵州茅台:2026年第一季度报告', 'quarterly')).toBe('2026-03-31');
    expect(inferCnPeriodEndOn('贵州茅台:2025年半年度报告', 'semiannual')).toBe('2025-06-30');
    expect(inferCnPeriodEndOn('贵州茅台:2025年度业绩快报', 'preliminary')).toBe('2025-12-31');
    expect(inferCnPeriodEndOn('贵州茅台:业绩预告', 'preview')).toBeUndefined();
  });
});
