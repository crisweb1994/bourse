import { describe, expect, it } from 'vitest';
import type { ResearchResult } from '../contracts/result';
import type { FinancialsBundle } from '../ports/financials';
import {
  sourceFinancialsPort,
  sourceInstrumentSearchPort,
  toSourceResult,
} from './provider-port';

function envelope<T>(data: T): ResearchResult<T> {
  return {
    schemaVersion: '1.0',
    data,
    citations: [],
    freshness: [],
    warnings: [],
  };
}

describe('provider source boundary', () => {
  it('rejects malformed canonical financial data before routing', async () => {
    const port = sourceFinancialsPort('financial-source', {
      async fetchFinancials() {
        return envelope({
          periods: [{ fiscalPeriod: 'FY2025' }],
          currency: 'US',
          sourceUrl: 'not-a-url',
          retrievedAt: 'not-a-date',
          provider: 'financial-source',
          qualityTier: 'A',
        } as unknown as FinancialsBundle);
      },
    });

    const result = await port.fetchFinancials({ instrumentId: 'US:AAPL' });

    expect(result.status).toBe('failed');
    if (result.status !== 'failed') throw new Error('expected validation failure');
    expect(result.error?.code).toBe('VALIDATION_FAILED');
  });

  it('rejects malformed provider metadata', () => {
    const result = toSourceResult('quote-source', {
      ...envelope({ price: 100 }),
      citations: [{ provider: 'quote-source' }] as never,
    }, () => true);

    expect(result.status).toBe('failed');
    if (result.status !== 'failed') throw new Error('expected validation failure');
    expect(result.error?.code).toBe('VALIDATION_FAILED');
  });

  it('rejects malformed instrument search rows', async () => {
    const port = sourceInstrumentSearchPort('search-source', {
      async search() {
        return [{ symbol: '', name: 'Broken', market: 'HK', exchange: '', currency: '', yahooSymbol: '' }];
      },
    });

    const result = await port.search('0700');

    expect(result.status).toBe('failed');
    if (result.status !== 'failed') throw new Error('expected validation failure');
    expect(result.error?.code).toBe('VALIDATION_FAILED');
  });
});
