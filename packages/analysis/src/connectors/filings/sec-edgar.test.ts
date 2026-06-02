import { describe, expect, it } from 'vitest';
import type { CikLookup } from './cik-lookup';
import { createSecEdgarFilingsConnector } from './sec-edgar';
import type { FetchLike } from '../types';

function stubFetch(body: unknown, ok = true, status = 200): FetchLike {
  return async () => ({ ok, status, json: async () => body });
}

function fakeLookup(map: Record<string, { cik: string; name: string }>): CikLookup {
  return {
    async resolve(ticker) {
      return map[ticker.toUpperCase()] ?? null;
    },
  };
}

const NVDA = { cik: '0001045810', name: 'NVIDIA CORP' };
const NVDA_SUBMISSIONS = {
  cik: '0001045810',
  name: 'NVIDIA CORP',
  filings: {
    recent: {
      accessionNumber: ['0001045810-24-000123', '0001045810-24-000099', '0001045810-23-000777'],
      filingDate: ['2024-08-28', '2024-05-22', '2023-02-21'],
      form: ['10-Q', '8-K', '10-K'],
      primaryDocument: ['nvda-20240728.htm', 'nvda-8k.htm', 'nvda-20240128.htm'],
      primaryDocDescription: ['10-Q', 'Current report', '10-K'],
    },
  },
};

describe('createSecEdgarFilingsConnector', () => {
  it('rejects construction without userAgent (SEC compliance)', () => {
    expect(() => createSecEdgarFilingsConnector({ userAgent: '' })).toThrow(/userAgent/);
    expect(() => createSecEdgarFilingsConnector({ userAgent: '   ' })).toThrow();
  });

  it('returns filings list with qualityTier=A citations', async () => {
    const c = createSecEdgarFilingsConnector({
      userAgent: 'test/1.0 contact@example.com',
      cikLookup: fakeLookup({ NVDA }),
      fetchLike: stubFetch(NVDA_SUBMISSIONS),
    });
    const out = await c.searchFilings({ instrumentId: 'US:NVDA' });
    expect(out.schemaVersion).toBe('1.0');
    expect(out.data).toHaveLength(3);
    expect(out.data[0]).toMatchObject({
      id: '0001045810-24-000123',
      instrumentId: 'US:NVDA',
      formType: '10-Q',
      filingDate: '2024-08-28',
      provider: 'sec-edgar',
    });
    expect(out.data[0].filingUrl).toBe(
      'https://www.sec.gov/Archives/edgar/data/1045810/000104581024000123/nvda-20240728.htm',
    );
    expect(out.citations).toHaveLength(3);
    expect(out.citations[0].qualityTier).toBe('A');
    expect(out.citations[0].sourceType).toBe('FILING');
    expect(out.warnings).toHaveLength(0);
  });

  it('filters by forms (case-insensitive)', async () => {
    const c = createSecEdgarFilingsConnector({
      userAgent: 'test',
      cikLookup: fakeLookup({ NVDA }),
      fetchLike: stubFetch(NVDA_SUBMISSIONS),
    });
    const out = await c.searchFilings({ instrumentId: 'US:NVDA', forms: ['10-k', '10-q'] });
    expect(out.data.map((f) => f.formType)).toEqual(['10-Q', '10-K']);
  });

  it('filters by date window [from, to]', async () => {
    const c = createSecEdgarFilingsConnector({
      userAgent: 'test',
      cikLookup: fakeLookup({ NVDA }),
      fetchLike: stubFetch(NVDA_SUBMISSIONS),
    });
    const out = await c.searchFilings({
      instrumentId: 'US:NVDA',
      from: '2024-01-01',
      to: '2024-12-31',
    });
    expect(out.data).toHaveLength(2);
    expect(out.data.map((f) => f.filingDate)).toEqual(['2024-08-28', '2024-05-22']);
  });

  it('respects limit', async () => {
    const c = createSecEdgarFilingsConnector({
      userAgent: 'test',
      cikLookup: fakeLookup({ NVDA }),
      fetchLike: stubFetch(NVDA_SUBMISSIONS),
    });
    const out = await c.searchFilings({ instrumentId: 'US:NVDA', limit: 1 });
    expect(out.data).toHaveLength(1);
  });

  it('returns UNSUPPORTED_MARKET for non-US instruments', async () => {
    const c = createSecEdgarFilingsConnector({
      userAgent: 'test',
      cikLookup: fakeLookup({ NVDA }),
      fetchLike: stubFetch(NVDA_SUBMISSIONS),
    });
    const out = await c.searchFilings({ instrumentId: 'CN:600519' });
    expect(out.warnings[0].code).toBe('UNSUPPORTED_MARKET');
  });

  it('returns INVALID_INSTRUMENT when ticker not found in CIK table', async () => {
    const c = createSecEdgarFilingsConnector({
      userAgent: 'test',
      cikLookup: fakeLookup({}),
      fetchLike: stubFetch(NVDA_SUBMISSIONS),
    });
    const out = await c.searchFilings({ instrumentId: 'US:DOESNOTEXIST' });
    expect(out.warnings[0].code).toBe('INVALID_INSTRUMENT');
    expect(out.warnings[0].message).toContain('DOESNOTEXIST');
  });

  it('classifies HTTP 403 as AUTH_REQUIRED (SEC blocks bad User-Agent)', async () => {
    const c = createSecEdgarFilingsConnector({
      userAgent: 'test',
      cikLookup: fakeLookup({ NVDA }),
      fetchLike: stubFetch({}, false, 403),
    });
    const out = await c.searchFilings({ instrumentId: 'US:NVDA' });
    expect(out.warnings[0].code).toBe('AUTH_REQUIRED');
  });

  it('classifies generic HTTP error as SOURCE_UNAVAILABLE', async () => {
    const c = createSecEdgarFilingsConnector({
      userAgent: 'test',
      cikLookup: fakeLookup({ NVDA }),
      fetchLike: stubFetch({}, false, 500),
    });
    const out = await c.searchFilings({ instrumentId: 'US:NVDA' });
    expect(out.warnings[0].code).toBe('SOURCE_UNAVAILABLE');
  });

  it('returns PARTIAL_DATA when submissions payload empty', async () => {
    const c = createSecEdgarFilingsConnector({
      userAgent: 'test',
      cikLookup: fakeLookup({ NVDA }),
      fetchLike: stubFetch({ cik: '0001045810' }),
    });
    const out = await c.searchFilings({ instrumentId: 'US:NVDA' });
    expect(out.warnings[0].code).toBe('PARTIAL_DATA');
  });

  it('surfaces CIK lookup failure as SOURCE_UNAVAILABLE', async () => {
    const failingLookup: CikLookup = {
      async resolve() {
        throw new Error('ticker table 502');
      },
    };
    const c = createSecEdgarFilingsConnector({
      userAgent: 'test',
      cikLookup: failingLookup,
      fetchLike: stubFetch(NVDA_SUBMISSIONS),
    });
    const out = await c.searchFilings({ instrumentId: 'US:NVDA' });
    expect(out.warnings[0].code).toBe('SOURCE_UNAVAILABLE');
    expect(out.warnings[0].cause).toContain('502');
  });

  it('getFiling is a PARTIAL_DATA stub (full-text deferred)', async () => {
    const c = createSecEdgarFilingsConnector({
      userAgent: 'test',
      cikLookup: fakeLookup({ NVDA }),
    });
    const out = await c.getFiling!({ id: '0001045810-24-000123' });
    expect(out.warnings[0].code).toBe('PARTIAL_DATA');
  });
});
