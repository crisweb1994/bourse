import { describe, expect, it } from 'vitest';
import {
  EarningsCardPayloadSchema,
  EarningsDataStatusSchema,
  type EarningsCardPayload,
} from './earnings';

function basePayload(overrides: Partial<EarningsCardPayload> = {}): EarningsCardPayload {
  return EarningsCardPayloadSchema.parse({
    schemaVersion: 'earnings-v1',
    event: {
      instrumentId: 'US:AAPL',
      periodEndOn: '2025-12-31',
      periodType: 'FY',
      fiscalYear: 2025,
      reportingScope: 'consolidated',
    },
    filing: {
      sourceKind: 'filing',
      filingId: 'filing-1',
      formType: '10-K',
      sourceUrl: 'https://www.sec.gov/Archives/edgar/data/1/0000000001-25-000001-index.html',
      publishedAt: '2025-02-01T00:00:00.000Z',
      provider: 'sec-edgar',
      unaudited: false,
      relationType: 'SUPPLEMENTS',
    },
    supportingFilings: [],
    facts: [],
    dataStatus: {
      numeric: 'ready',
      narrative: 'unavailable',
      guidance: 'none_reported',
    },
    managementClaims: [],
    omittedFactCount: 0,
    statusSummary: {
      total: 0,
      reconciled: 0,
      pending: 0,
      conflicted: 0,
      structuredOnly: 0,
    },
    generatedAt: '2025-02-01T00:00:00.000Z',
    ...overrides,
  });
}

describe('earnings dataStatus contract', () => {
  it('accepts all documented status combinations', () => {
    const dataStatus = EarningsDataStatusSchema.parse({
      numeric: 'pending_structured',
      narrative: 'ready',
      guidance: 'none_reported',
    });
    expect(dataStatus.numeric).toBe('pending_structured');
  });

  it('rejects unknown status values', () => {
    expect(() =>
      EarningsDataStatusSchema.parse({
        numeric: 'complete',
        narrative: 'ready',
        guidance: 'none_reported',
      }),
    ).toThrow();
  });

  it('requires dataStatus on every card payload', () => {
    expect(basePayload().dataStatus).toEqual({
      numeric: 'ready',
      narrative: 'unavailable',
      guidance: 'none_reported',
    });
    const structured = basePayload({
      dataStatus: {
        numeric: 'ready',
        narrative: 'unavailable',
        guidance: 'none_reported',
      },
    });
    expect(structured.dataStatus).toEqual({
      numeric: 'ready',
      narrative: 'unavailable',
      guidance: 'none_reported',
    });
  });
});
