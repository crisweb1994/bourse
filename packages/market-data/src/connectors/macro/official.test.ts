import { describe, expect, it } from 'vitest';
import { MacroSnapshotSchema } from '../../ports/macro';
import type { FetchLike } from '../types';
import { createOfficialMacroConnector } from './official';

const NOW = new Date('2026-07-28T00:00:00.000Z');

function worldBankPayload(url: string): unknown {
  const seriesId = url.match(/\/indicator\/([^?]+)/)?.[1] ?? '';
  const value = seriesId === 'NY.GDP.MKTP.KD.ZG' ? 2.1
    : seriesId === 'FP.CPI.TOTL.ZG' ? 2.7
      : 4.2;
  return [{}, [{ date: '2025', value }]];
}

function jsonResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

describe('official macro connector', () => {
  it('combines World Bank, FRED, and US Treasury observations for the US', async () => {
    const fetchLike: FetchLike = async (url) => {
      if (url.includes('api.worldbank.org')) return jsonResponse(worldBankPayload(url));
      if (url.includes('id=FEDFUNDS')) {
        return { ...jsonResponse({}), text: async () => 'observation_date,FEDFUNDS\n2026-06-01,4.33\n' };
      }
      if (url.includes('id=DGS10')) {
        return { ...jsonResponse({}), text: async () => 'observation_date,DGS10\n2026-07-24,4.41\n' };
      }
      if (url.includes('debt_to_penny')) {
        return jsonResponse({
          data: [{ record_date: '2026-07-24', tot_pub_debt_out_amt: '39692374867364.99' }],
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    };
    const connector = createOfficialMacroConnector({ fetchLike, now: () => NOW });

    const result = await connector.fetchMacro({ market: 'US' });

    expect(MacroSnapshotSchema.parse(result.data)).toEqual(result.data);
    expect(result.data.observations).toHaveLength(6);
    expect(result.data.observations).toContainEqual(expect.objectContaining({
      seriesCode: 'US.FEDERAL_DEBT',
      value: '39692374867364.99',
      unit: 'USD',
      provider: 'us-treasury',
    }));
    expect(result.citations.some((citation) => citation.provider === 'us-treasury')).toBe(true);
    expect(result.freshness.some((freshness) => freshness.provider === 'us-treasury')).toBe(true);
    expect(result.warnings).toHaveLength(0);
  });

  it('keeps other official data when Treasury is unavailable', async () => {
    const fetchLike: FetchLike = async (url) => {
      if (url.includes('api.worldbank.org')) return jsonResponse(worldBankPayload(url));
      if (url.includes('fredgraph.csv')) {
        return { ...jsonResponse({}), text: async () => 'date,value\n2026-07-24,4.2\n' };
      }
      if (url.includes('debt_to_penny')) return jsonResponse({}, 503);
      throw new Error(`Unexpected URL: ${url}`);
    };
    const connector = createOfficialMacroConnector({ fetchLike, now: () => NOW });

    const result = await connector.fetchMacro({ market: 'US' });

    expect(result.data.observations.length).toBeGreaterThan(0);
    expect(result.data.observations.some((item) => item.provider === 'us-treasury')).toBe(false);
    expect(result.warnings).toContainEqual(expect.objectContaining({
      code: 'SOURCE_UNAVAILABLE',
      provider: 'us-treasury',
    }));
  });

  it('reads HKMA exchange-rate and HIBOR series for Hong Kong', async () => {
    const fetchLike: FetchLike = async (url) => {
      if (url.includes('api.worldbank.org')) return jsonResponse(worldBankPayload(url));
      const field = url.includes('er-eeri-daily') ? { usd: '7.8499' } : { ir_3m: '3.21' };
      return jsonResponse({
        header: { success: true },
        result: { records: [{ end_of_day: '2026-07-24', ...field }] },
      });
    };
    const connector = createOfficialMacroConnector({ fetchLike, now: () => NOW });

    const result = await connector.fetchMacro({ market: 'HK' });

    expect(result.data.observations).toContainEqual(expect.objectContaining({
      seriesCode: 'HK.USD_EXCHANGE_RATE', provider: 'hkma', value: '7.8499',
    }));
    expect(result.data.observations).toContainEqual(expect.objectContaining({
      seriesCode: 'HK.INTERBANK_RATE_3M', provider: 'hkma', value: '3.21',
    }));
  });

  it('fetches only explicitly requested canonical series', async () => {
    const urls: string[] = [];
    const fetchLike: FetchLike = async (url) => {
      urls.push(url);
      return { ...jsonResponse({}), text: async () => 'observation_date,DGS10\n2026-07-24,4.41\n' };
    };
    const connector = createOfficialMacroConnector({ fetchLike, now: () => NOW });

    const result = await connector.fetchMacro({
      market: 'US',
      seriesCodes: ['US.GOVERNMENT_BOND_10Y'],
    });

    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain('id=DGS10');
    expect(result.data.observations.map((item) => item.seriesCode))
      .toEqual(['US.GOVERNMENT_BOND_10Y']);
  });
});
