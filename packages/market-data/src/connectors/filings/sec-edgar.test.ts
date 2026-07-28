import { describe, expect, it } from 'vitest';
import type { CikLookup } from './cik-lookup';
import {
  createSecEdgarFilingsConnector,
  htmlToFilingText,
  isEarningsReleaseText,
  selectEarningsExhibit,
} from './sec-edgar';
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
      reportDate: ['2024-07-28', '2024-04-28', '2024-01-28'],
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
      periodEndOn: '2024-07-28',
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

  it('rejects getFiling without a trusted SEC Archives URL', async () => {
    const c = createSecEdgarFilingsConnector({
      userAgent: 'test',
      cikLookup: fakeLookup({ NVDA }),
    });
    const out = await c.getFiling!({ id: '0001045810-24-000123' });
    expect(out.warnings[0].code).toBe('INVALID_INSTRUMENT');
  });

  it('loads the 8-K index and selects the earnings EX-99.1 document', async () => {
    const indexHtml = `
      <table class="tableFile">
        <tr><th>Seq</th><th>Description</th><th>Document</th><th>Type</th></tr>
        <tr><td>1</td><td>8-K</td><td><a href="nvda-8k.htm">nvda-8k.htm</a></td><td>8-K</td></tr>
        <tr><td>2</td><td>Earnings release</td><td><a href="earnings.htm">earnings.htm</a></td><td>EX-99.1</td></tr>
      </table>`;
    const fetchLike: FetchLike = async (url) => {
      if (url.endsWith('-index.html')) {
        return { ok: true, status: 200, json: async () => ({}), text: async () => indexHtml };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({}),
        text: async () => '<html><body><h1>Quarterly financial results</h1><p>Revenue was $10 billion. Diluted earnings per share was $2.</p></body></html>',
      };
    };
    const c = createSecEdgarFilingsConnector({ userAgent: 'test', fetchLike });
    const out = await c.getFiling!({
      id: '0001045810-24-000099',
      sourceDocumentId: '0001045810-24-000099',
      instrumentId: 'US:NVDA',
      formType: '8-K',
      filingUrl: 'https://www.sec.gov/Archives/edgar/data/1045810/000104581024000099/nvda-8k.htm',
      title: 'Current report',
    });
    expect(out.warnings).toEqual([]);
    expect(out.data.documentKind).toBe('EARNINGS_RELEASE');
    expect(out.data.filingUrl).toContain('earnings.htm');
    expect(out.data.sourceDocumentId).toContain(':earnings.htm');
    expect(out.data.text).toContain('Revenue was $10 billion.');
    expect(out.data.contentHash).toHaveLength(64);
  });
});

describe('SEC filing document helpers', () => {
  it('prefers a described earnings exhibit', () => {
    const html = `<table class="tableFile">
      <tr><td>1</td><td>Other exhibit</td><td><a href="other.htm">other</a></td><td>EX-99</td></tr>
      <tr><td>2</td><td>Quarterly earnings results</td><td><a href="earnings.htm">earnings</a></td><td>EX-99.1</td></tr>
    </table>`;
    expect(selectEarningsExhibit(html, 'https://www.sec.gov/Archives/edgar/data/1/2'))
      .toBe('https://www.sec.gov/Archives/edgar/data/1/2/earnings.htm');
  });

  it('removes scripts and preserves block boundaries', () => {
    const text = htmlToFilingText('<body><h1>Title</h1><script>bad()</script><p>Revenue 10</p></body>');
    expect(text).toContain('Title');
    expect(text).toContain('Revenue 10');
    expect(text).not.toContain('bad()');
  });

  it('rejects non-earnings EX-99.1 press releases', () => {
    expect(isEarningsReleaseText('Alphabet announces an $80 billion equity capital raise.')).toBe(false);
    expect(isEarningsReleaseText('Microsoft announces appointment of a new director to the board.')).toBe(false);
    expect(isEarningsReleaseText('Company reports first quarter financial results. Revenue was $10 billion and diluted earnings per share was $2.')).toBe(true);
  });
});
