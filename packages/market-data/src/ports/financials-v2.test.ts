import { describe, expect, it } from 'vitest';
import {
  FinancialFactSchema,
  FinancialPeriodSchema,
  FinancialsBundleV2Schema,
  type FinancialFact,
  type FinancialPeriod,
  type FinancialsBundleV2,
} from './financials-v2';

function makeFact(overrides: Partial<FinancialFact> = {}): FinancialFact {
  return FinancialFactSchema.parse({
    id: 'fact-revenue-fy',
    metricCode: 'revenue',
    value: '1000000',
    unit: 'currency',
    currency: 'USD',
    scale: 1,
    periodKind: 'duration',
    periodStartOn: '2025-01-01',
    periodEndOn: '2025-12-31',
    accumulation: 'FY',
    accountingBasis: 'US-GAAP',
    reportingScope: 'consolidated',
    derivation: { kind: 'reported' },
    provenance: {
      provider: 'sec-edgar-xbrl',
      sourceNature: 'official_structured',
      qualityTier: 'A',
      sourceUrl: 'https://data.sec.gov/api/xbrl/companyfacts/CIK0000320193.json',
      sourceField: 'RevenueFromContractWithCustomerExcludingAssessedTax',
      accessionNumber: '0000320193-25-000001',
      sourceFiledAt: '2025-02-01T00:00:00.000Z',
      snapshotId: 'snap-1',
      retrievedAt: '2025-02-01T01:00:00.000Z',
    },
    ...overrides,
  });
}

function makePeriod(overrides: Partial<FinancialPeriod> = {}): FinancialPeriod {
  return FinancialPeriodSchema.parse({
    id: 'period-fy-2025',
    fiscalYear: 2025,
    fiscalPeriodType: 'FY',
    periodStartOn: '2025-01-01',
    periodEndOn: '2025-12-31',
    publishedAt: '2025-02-01T00:00:00.000Z',
    formType: '10-K',
    reportingScope: 'consolidated',
    accountingBasis: 'US-GAAP',
    revision: { kind: 'original' },
    facts: [makeFact()],
    ...overrides,
  });
}

function makeBundle(overrides: Partial<FinancialsBundleV2> = {}): FinancialsBundleV2 {
  return FinancialsBundleV2Schema.parse({
    schemaVersion: 'financials-v2',
    instrumentId: 'US:AAPL',
    provider: 'sec-edgar-xbrl',
    sourceNature: 'official_structured',
    qualityTier: 'A',
    sourceUrl: 'https://data.sec.gov/api/xbrl/companyfacts/CIK0000320193.json',
    retrievedAt: '2025-02-01T01:00:00.000Z',
    snapshotId: 'snap-1',
    periods: [makePeriod()],
    ...overrides,
  });
}

describe('financials-v2 contract', () => {
  it('accepts a minimal valid bundle', () => {
    const bundle = makeBundle();
    expect(bundle.schemaVersion).toBe('financials-v2');
    expect(bundle.periods[0].facts[0].metricCode).toBe('revenue');
  });

  it('rejects duration facts without periodStartOn', () => {
    expect(() =>
      makeFact({ periodKind: 'duration', periodStartOn: undefined, accumulation: 'FY' }),
    ).toThrow();
  });

  it('rejects duration facts without accumulation', () => {
    expect(() =>
      makeFact({ periodKind: 'duration', periodStartOn: '2025-01-01', accumulation: undefined }),
    ).toThrow();
  });

  it('rejects instant facts carrying accumulation', () => {
    expect(() =>
      makeFact({
        id: 'fact-assets-fy',
        metricCode: 'totalAssets',
        periodKind: 'instant',
        accumulation: 'discrete',
      }),
    ).toThrow();
  });

  it('accepts instant facts without accumulation', () => {
    const fact = makeFact({
      id: 'fact-assets-fy',
      metricCode: 'totalAssets',
      periodKind: 'instant',
      periodStartOn: undefined,
      accumulation: undefined,
    });
    expect(fact.periodKind).toBe('instant');
  });

  it('rejects currency facts without currency', () => {
    expect(() => makeFact({ currency: undefined })).toThrow();
  });

  it('rejects per_share facts without currency', () => {
    expect(() =>
      makeFact({
        id: 'fact-eps',
        metricCode: 'epsDiluted',
        value: '6.34',
        unit: 'per_share',
        currency: undefined,
        accumulation: 'FY',
      }),
    ).toThrow();
  });

  it('rejects computed facts without input facts', () => {
    expect(() =>
      makeFact({
        id: 'fact-fcf',
        metricCode: 'freeCashFlow',
        derivation: { kind: 'computed', formula: 'ocf - capex', inputFactIds: [] },
      }),
    ).toThrow();
  });

  it('rejects non-decimal values', () => {
    expect(() => makeFact({ value: '1e3' })).toThrow();
  });

  it('accepts negative decimal values', () => {
    expect(() => makeFact({ value: '-0.5' })).not.toThrow();
  });

  it('rejects TTM facts that are not computed with four inputs', () => {
    const q1 = makeFact({
      id: 'q1',
      value: '100',
      periodStartOn: '2024-01-01',
      periodEndOn: '2024-03-31',
      accumulation: 'discrete',
    });
    const q2 = makeFact({
      id: 'q2',
      value: '200',
      periodStartOn: '2024-04-01',
      periodEndOn: '2024-06-30',
      accumulation: 'discrete',
    });
    const q3 = makeFact({
      id: 'q3',
      value: '300',
      periodStartOn: '2024-07-01',
      periodEndOn: '2024-09-30',
      accumulation: 'discrete',
    });
    const q4 = makeFact({
      id: 'q4',
      value: '400',
      periodStartOn: '2024-10-01',
      periodEndOn: '2024-12-31',
      accumulation: 'discrete',
    });
    const quarterPeriods = [
      makePeriod({
        id: 'period-q1-2024',
        fiscalYear: 2024,
        fiscalPeriodType: 'Q1',
        periodStartOn: '2024-01-01',
        periodEndOn: '2024-03-31',
        facts: [q1],
      }),
      makePeriod({
        id: 'period-q2-2024',
        fiscalYear: 2024,
        fiscalPeriodType: 'Q2',
        periodStartOn: '2024-04-01',
        periodEndOn: '2024-06-30',
        facts: [q2],
      }),
      makePeriod({
        id: 'period-q3-2024',
        fiscalYear: 2024,
        fiscalPeriodType: 'Q3',
        periodStartOn: '2024-07-01',
        periodEndOn: '2024-09-30',
        facts: [q3],
      }),
      makePeriod({
        id: 'period-q4-2024',
        fiscalYear: 2024,
        fiscalPeriodType: 'Q4',
        periodStartOn: '2024-10-01',
        periodEndOn: '2024-12-31',
        facts: [q4],
      }),
    ];
    const ttmBase = makeFact({
      id: 'fact-ttm',
      periodKind: 'duration',
      periodStartOn: '2024-04-01',
      periodEndOn: '2025-03-31',
      accumulation: 'TTM',
      derivation: {
        kind: 'computed',
        formula: 'ttm-v1',
        inputFactIds: ['a', 'b', 'c'],
      },
    });

    // TTM period 里必须全部是 computed fact（bundle 级校验）。
    expect(() =>
      makeBundle({
        periods: [
          makePeriod({
            id: 'period-ttm',
            fiscalPeriodType: 'TTM',
            facts: [
              {
                ...ttmBase,
                derivation: { kind: 'reported' },
              },
            ],
          }),
        ],
      }),
    ).toThrow('must be computed');

    // 不足四个输入期间。
    expect(() =>
      makeBundle({
        periods: [
          ...quarterPeriods,
          makePeriod({
            id: 'period-ttm',
            fiscalPeriodType: 'TTM',
            facts: [
              {
                ...ttmBase,
                derivation: {
                  kind: 'computed',
                  formula: 'ttm-v1',
                  inputFactIds: ['q1', 'q2', 'q3'],
                },
              },
            ],
          }),
        ],
      }),
    ).toThrow('must reference four input periods');

    // TTM accumulation 必须是 TTM。
    expect(() =>
      makeBundle({
        periods: [
          ...quarterPeriods,
          makePeriod({
            id: 'period-ttm',
            fiscalPeriodType: 'TTM',
            facts: [
              {
                ...ttmBase,
                accumulation: 'discrete',
                derivation: {
                  kind: 'computed',
                  formula: 'ttm-v1',
                  inputFactIds: ['q1', 'q2', 'q3', 'q4'],
                },
              },
            ],
          }),
        ],
      }),
    ).toThrow('accumulation TTM');
  });

  it('rejects FY duration facts with YTD accumulation', () => {
    expect(() =>
      makeBundle({
        periods: [
          makePeriod({
            facts: [
              makeFact({
                id: 'fact-revenue-ytd',
                accumulation: 'YTD',
                periodKind: 'duration',
                periodStartOn: '2025-01-01',
              }),
            ],
          }),
        ],
      }),
    ).toThrow('must have accumulation FY');
  });

  it('rejects duplicate reported facts without revision distinction', () => {
    const factA = makeFact();
    const factB = makeFact({ id: 'fact-revenue-fy-2' });
    expect(() =>
      makeBundle({
        periods: [makePeriod({ facts: [factA, factB] })],
      }),
    ).toThrow('duplicate reported facts');
  });

  it('accepts duplicate reported facts distinguishable by accession', () => {
    const factA = makeFact();
    const factB = makeFact({
      id: 'fact-revenue-fy-2',
      provenance: {
        ...factA.provenance,
        accessionNumber: '0000320193-25-000002',
        sourceFiledAt: '2025-03-01T00:00:00.000Z',
        sourceRevisionId: 'rev-2',
      },
    });
    expect(() =>
      makeBundle({
        periods: [makePeriod({ facts: [factA, factB] })],
      }),
    ).not.toThrow();
  });

  it('rejects computed facts referencing unknown input facts', () => {
    const factA = makeFact();
    const computed = makeFact({
      id: 'fact-fcf',
      metricCode: 'freeCashFlow',
      derivation: { kind: 'computed', formula: 'ocf - capex', inputFactIds: ['missing-fact'] },
    });
    expect(() =>
      makeBundle({
        periods: [makePeriod({ facts: [factA, computed] })],
      }),
    ).toThrow('unknown input fact');
  });

  it('rejects facts whose snapshotId differs from the bundle snapshotId', () => {
    const fact = makeFact({
      provenance: { ...makeFact().provenance, snapshotId: 'snap-other' },
    });
    expect(() =>
      makeBundle({
        periods: [makePeriod({ facts: [fact] })],
      }),
    ).toThrow('does not match bundle snapshotId');
  });

  it('rejects duplicate period ids and fact ids', () => {
    expect(() =>
      makeBundle({
        periods: [makePeriod(), makePeriod()],
      }),
    ).toThrow('duplicate period id');
    expect(() =>
      makeBundle({
        periods: [
          makePeriod(),
          makePeriod({
            id: 'period-fy-2024',
            fiscalYear: 2024,
            facts: [makeFact({ id: 'fact-revenue-fy' })],
          }),
        ],
      }),
    ).toThrow('duplicate fact id');
  });
});
