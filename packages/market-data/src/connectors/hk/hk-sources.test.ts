import { describe, expect, it, vi } from 'vitest';
import { RESEARCH_SCHEMA_VERSION } from '../../contracts/result';
import type { ProviderFilingPort } from '../../ports/filings';
import type { FetchLike } from '../types';
import { createHkexDerivedCorporateActionsConnector, createHkexDerivedMarketEventsConnector } from './hkex-derived-events';
import { createSfcShortPositionConnector } from './sfc-short-position';

const upstream: ProviderFilingPort = {
  async searchFilings(input) {
    const retrievedAt = '2026-07-30T00:00:00.000Z';
    const filings = [
      { id: '1', sourceDocumentId: 'news-1', instrumentId: input.instrumentId, formType: 'other', filingDate: '2026-07-29T08:00:00.000Z', filingUrl: 'https://www1.hkexnews.hk/listedco/listconews/sehk/2026/0729/a.pdf', title: 'Declaration of Special Dividend', provider: 'hkex' },
      { id: '2', sourceDocumentId: 'news-2', instrumentId: input.instrumentId, formType: 'profit_warning', filingDate: '2026-07-28T08:00:00.000Z', filingUrl: 'https://www1.hkexnews.hk/listedco/listconews/sehk/2026/0728/b.pdf', title: 'Profit Warning', provider: 'hkex' },
    ];
    return { schemaVersion: RESEARCH_SCHEMA_VERSION, data: filings, citations: filings.map((item) => ({ title: item.title, url: item.filingUrl, sourceType: 'FILING' as const, provider: 'hkex', retrievedAt })), freshness: [{ provider: 'hkex', asOf: retrievedAt, retrievedAt, stale: false }], warnings: [] };
  },
};

describe('HK official-derived sources', () => {
  it('derives company actions while retaining the HKEX document id and URL', async () => {
    const result = await createHkexDerivedCorporateActionsConnector(upstream).listActions({ instrumentId: 'HK:0700', dataSet: 'dividend' });
    expect(result.data).toEqual([expect.objectContaining({ type: 'DIVIDEND', sourceDocumentId: 'news-1' })]);
    expect(result.citations[0]?.url).toContain('hkexnews.hk');
    expect(result.citations[0]?.provider).toBe('hkex-filings-derived-events');
  });

  it('derives earnings guidance only for the requested event dataset', async () => {
    const result = await createHkexDerivedMarketEventsConnector(upstream).listEvents({ instrumentId: 'HK:0700', dataSet: 'earnings-guidance' });
    expect(result.data).toEqual([expect.objectContaining({ type: 'EARNINGS_GUIDANCE', sourceDocumentId: 'news-2' })]);
  });

  it('parses the SFC weekly CSV and rejects silent schema drift', async () => {
    const fetchLike: FetchLike = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({}),
      text: async () => 'Reporting Date,Stock Code,Name,Aggregated Short Position,Aggregated Short Position Value\r\n2026/07/24,700,Tencent,"12,345,678","7,000,000,000"\r\n',
    }));
    const connector = createSfcShortPositionConnector({ fetchLike, csvUrl: 'https://www.sfc.hk/reviewed/current.csv' });
    const result = await connector.listOwnership({ instrumentId: 'HK:0700', dataSet: 'short-position' });
    expect(result.data).toEqual([expect.objectContaining({ kind: 'SHORT_POSITION', value: '12345678', unit: 'shares' })]);

    const drifted = createSfcShortPositionConnector({ csvUrl: 'https://www.sfc.hk/reviewed/current.csv', fetchLike: vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => 'Unknown,Columns\n1,2\n' })) });
    const failed = await drifted.listOwnership({ instrumentId: 'HK:0700', dataSet: 'short-position' });
    expect(failed.data).toEqual([]);
    expect(failed.warnings[0]?.code).toBe('INVALID_PAYLOAD');
  });
});
