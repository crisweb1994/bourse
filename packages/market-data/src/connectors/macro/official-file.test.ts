import { describe, expect, it, vi } from 'vitest';
import type { FetchLike } from '../types';
import { createOfficialMacroFileConnector, createOfficialMacroFileSourcePlugin, type OfficialMacroFileSourceConfig } from './official-file';

const source: OfficialMacroFileSourceConfig = {
  id: 'pboc-cn-macro',
  name: 'People\'s Bank of China',
  series: [{
    seriesCode: 'CN.M2.YOY',
    providerSeriesId: 'M2_YOY',
    name: 'Broad money M2 YoY',
    category: 'money',
    unit: 'percent',
    frequency: 'MONTHLY',
    url: 'https://www.pbc.gov.cn/official/m2.csv',
    columns: { period: 'Period', value: 'M2 YoY', releasedAt: 'Released At' },
    seasonalAdjustment: 'NSA',
  }],
};

describe('official macro file source', () => {
  it('normalizes a reviewed official CSV using exact declared headers', async () => {
    const fetchLike: FetchLike = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => 'Period,M2 YoY,Released At\n2026-06,8.3,2026-07-14\n' }));
    const result = await createOfficialMacroFileConnector({ ...source, fetchLike }).fetchMacro({ market: 'CN', seriesCodes: ['CN.M2.YOY'] });
    expect(result.data.observations).toEqual([expect.objectContaining({ seriesCode: 'CN.M2.YOY', value: '8.3', periodEnd: '2026-06-30', releasedAt: '2026-07-14T00:00:00.000Z' })]);
    expect(createOfficialMacroFileSourcePlugin(source).manifest.capabilities[0]).toMatchObject({ seriesCodes: ['CN.M2.YOY'], transport: 'official-file' });
  });

  it('turns a changed header into INVALID_PAYLOAD', async () => {
    const fetchLike: FetchLike = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => 'New Period,New Value\n2026-06,8.3\n' }));
    const result = await createOfficialMacroFileConnector({ ...source, fetchLike }).fetchMacro({ market: 'CN', seriesCodes: ['CN.M2.YOY'] });
    expect(result.data.observations).toEqual([]);
    expect(result.warnings[0]?.code).toBe('INVALID_PAYLOAD');
  });
});
