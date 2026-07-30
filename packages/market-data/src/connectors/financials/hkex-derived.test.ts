import { describe, expect, it } from 'vitest';
import type { ResearchResult } from '../../contracts/result';
import type {
  FilingDocument,
  FilingSummary,
  ProviderFilingPort as FilingPort,
} from '../../ports/filings';
import { createHkexDerivedFinancialsConnector } from './hkex-derived';

const summary: FilingSummary = {
  id: 'hkex-1',
  sourceDocumentId: 'hkex-1',
  instrumentId: 'HK:0700',
  formType: 'preliminary',
  filingDate: '2026-03-18T04:30:00.000Z',
  periodEndOn: '2025-12-31',
  filingUrl: 'https://www1.hkexnews.hk/annual-results.pdf',
  title: 'ANNUAL RESULTS FOR THE YEAR ENDED 31 DECEMBER 2025',
  provider: 'hkex',
  language: 'en-HK',
};

describe('HKEX-derived financials', () => {
  it('derives explicitly labelled annual facts with declared currency and scale', async () => {
    const connector = createHkexDerivedFinancialsConnector({
      filings: filingPort([
        'HK$ million',
        'Revenue 660,257 609,015',
        'Operating profit 218,307 201,937',
        'Profit attributable to equity holders 194,073 161,920',
        'Total assets 1,810,000 1,650,000',
        'Total liabilities 702,000 650,000',
      ].join('\n')),
      now: () => new Date('2026-03-19T00:00:00.000Z'),
    });

    const result = await connector.fetchFinancials({ instrumentId: 'HK:0700' });

    expect(result.data?.provider).toBe('hkex-derived-financials');
    expect(result.data?.currency).toBe('HKD');
    expect(result.data?.periods[0]?.income.revenue?.value).toBe(660_257_000_000);
    expect(result.data?.periods[0]?.income.netIncome?.value).toBe(194_073_000_000);
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: 'NORMALIZED_WITH_ASSUMPTION' }));
  });

  it('returns empty when the document does not declare an auditable unit', async () => {
    const connector = createHkexDerivedFinancialsConnector({
      filings: filingPort('Revenue 660,257\nNet profit 194,073'),
    });

    const result = await connector.fetchFinancials({ instrumentId: 'HK:0700' });

    expect(result.data).toBeNull();
  });
});

function filingPort(text: string): FilingPort {
  return {
    async searchFilings() {
      return envelope([summary]);
    },
    async getFiling() {
      return envelope<FilingDocument>({ ...summary, text });
    },
  };
}

function envelope<T>(data: T): ResearchResult<T> {
  return {
    schemaVersion: '1.0',
    data,
    citations: [{
      title: 'HKEX annual results',
      url: summary.filingUrl,
      sourceType: 'FILING',
      provider: 'hkex',
      retrievedAt: '2026-03-19T00:00:00.000Z',
      qualityTier: 'A',
    }],
    freshness: [],
    warnings: [],
  };
}
