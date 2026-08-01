import { describe, expect, it, vi } from 'vitest';
import type { FetchLike } from '../types';
import { createNbsMacroConnector, createNbsMacroSourcePlugin } from './nbs';

describe('NBS macro source', () => {
  it('declares exact canonical series and parses the official data-node shape', async () => {
    const fetchLike: FetchLike = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        returncode: 200,
        returndata: {
          datanodes: [
            { code: 'zb.A010101_sj.202506', data: { data: '-0.1', hasdata: true }, wds: [{ wdcode: 'zb', valuecode: 'A010101' }, { wdcode: 'sj', valuecode: '202506' }] },
            { code: 'zb.A010101_sj.202505', data: { data: '0.1', hasdata: true }, wds: [{ wdcode: 'zb', valuecode: 'A010101' }, { wdcode: 'sj', valuecode: '202505' }] },
          ],
        },
      }),
    }));
    const connector = createNbsMacroConnector({ fetchLike });
    const result = await connector.fetchMacro({ market: 'CN', seriesCodes: ['CN.CPI.YOY'], limitPerSeries: 1 });
    expect(result.data.observations).toEqual([
      expect.objectContaining({ seriesCode: 'CN.CPI.YOY', value: '-0.1', periodStart: '2025-06-01', periodEnd: '2025-06-30', providerSeriesId: 'A010101' }),
    ]);
    expect(createNbsMacroSourcePlugin().manifest.capabilities[0]?.seriesCodes).toContain('CN.PMI.MANUFACTURING');
  });

  it('reports schema drift instead of returning a silent empty result', async () => {
    const fetchLike: FetchLike = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ returndata: { changed: [] } }) }));
    const result = await createNbsMacroConnector({ fetchLike }).fetchMacro({ market: 'CN', seriesCodes: ['CN.CPI.YOY'] });
    expect(result.data.observations).toEqual([]);
    expect(result.warnings[0]?.code).toBe('INVALID_PAYLOAD');
  });
});
