import { describe, expect, it } from 'vitest';
import {
  FinancialFactSchema,
  FinancialPeriodSchema,
  FinancialsBundleV2Schema,
  type FinancialFact,
  type FinancialPeriod,
  type FinancialsBundleV2,
} from '@bourse/market-data';
import type { MetricFact } from '../../contracts/earnings';
import {
  projectStructuredEarnings,
  type StructuredEarningsSelection,
  type StructuredEarningsSelectionInput,
} from '../structured-earnings-selector';

const NOW = '2025-12-31T00:00:00.000Z';
const SNAPSHOT_ID = 'snap-1';

function makeFact(overrides: Partial<FinancialFact> = {}): FinancialFact {
  return FinancialFactSchema.parse({
    id: 'fact-revenue',
    metricCode: 'revenue',
    value: '1000',
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
      accessionNumber: 'acc-1',
      sourceFiledAt: '2025-01-20T00:00:00.000Z',
      snapshotId: SNAPSHOT_ID,
      retrievedAt: NOW,
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
    publishedAt: '2025-01-20T00:00:00.000Z',
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
    retrievedAt: NOW,
    snapshotId: SNAPSHOT_ID,
    periods: [makePeriod()],
    ...overrides,
  });
}

function select(
  bundle: FinancialsBundleV2,
  overrides: Partial<StructuredEarningsSelectionInput> = {},
): StructuredEarningsSelection {
  return projectStructuredEarnings({
    bundle,
    market: 'US',
    expectedPeriodEndOn: '2025-12-31',
    expectedPeriodType: 'FY',
    eventPublishedAt: '2025-01-20T00:00:00.000Z',
    knowledgeCutoffAt: NOW,
    now: NOW,
    ...overrides,
  });
}

describe('projectStructuredEarnings', () => {
  it('selects the exact US Q1 period', () => {
    const bundle = makeBundle({
      periods: [
        makePeriod({
          id: 'period-q1-2025',
          fiscalYear: 2025,
          fiscalPeriodType: 'Q1',
          periodStartOn: '2025-01-01',
          periodEndOn: '2025-03-31',
          publishedAt: '2025-04-15T00:00:00.000Z',
          formType: '10-Q',
          facts: [
            makeFact({
              id: 'fact-revenue-q1',
              value: '10000',
              periodStartOn: '2025-01-01',
              periodEndOn: '2025-03-31',
              accumulation: 'discrete',
              provenance: { ...makeFact().provenance, sourceFiledAt: '2025-04-15T00:00:00.000Z' },
            }),
            makeFact({
              id: 'fact-assets-q1',
              metricCode: 'totalAssets',
              value: '5000000',
              periodKind: 'instant',
              periodStartOn: undefined,
              accumulation: undefined,
            }),
          ],
        }),
      ],
    });
    const result = select(bundle, {
      expectedPeriodEndOn: '2025-03-31',
      expectedPeriodType: 'Q1',
    });
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') return;
    expect(result.period.id).toBe('period-q1-2025');
    expect(result.facts.map((fact) => fact.metricCode).sort()).toEqual([
      'revenue',
      'totalAssets',
    ]);
    const revenue = result.facts.find((fact) => fact.metricCode === 'revenue')!;
    expect(revenue.accumulation).toBe('discrete');
  });

  it('prefers the exact period over the latest period', () => {
    const bundle = makeBundle({
      periods: [
        makePeriod({ id: 'period-fy-2025' }),
        makePeriod({
          id: 'period-q1-2025',
          fiscalYear: 2025,
          fiscalPeriodType: 'Q1',
          periodStartOn: '2025-01-01',
          periodEndOn: '2025-03-31',
          publishedAt: '2025-04-15T00:00:00.000Z',
          formType: '10-Q',
          facts: [
            makeFact({
              id: 'fact-revenue-q1',
              value: '2500',
              periodStartOn: '2025-01-01',
              periodEndOn: '2025-03-31',
              accumulation: 'discrete',
              provenance: { ...makeFact().provenance, sourceFiledAt: '2025-04-15T00:00:00.000Z' },
            }),
          ],
        }),
      ],
    });
    const result = select(bundle, {
      expectedPeriodEndOn: '2025-03-31',
      expectedPeriodType: 'Q1',
    });
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') return;
    expect(result.period.id).toBe('period-q1-2025');
    expect(result.facts[0].value).toEqual({ kind: 'scalar', value: '2500' });
  });

  it('uses reported H1 YTD for CN and rejects derived Q2', () => {
    const bundle = makeBundle({
      instrumentId: 'CN:600519',
      provider: 'eastmoney-financials',
      sourceNature: 'aggregated_structured',
      qualityTier: 'B',
      sourceUrl: 'https://emweb.eastmoney.com/PC_HSF10/NewFinanceAnalysis/index?type=web&code=600519',
      periods: [
        makePeriod({
          id: 'period-h1-2025',
          fiscalYear: 2025,
          fiscalPeriodType: 'H1',
          periodStartOn: '2025-01-01',
          periodEndOn: '2025-06-30',
          accountingBasis: 'CAS',
          publishedAt: '2025-08-20T00:00:00.000Z',
          facts: [
            makeFact({
              id: 'fact-revenue-h1',
              value: '6000',
              currency: 'CNY',
              periodStartOn: '2025-01-01',
              periodEndOn: '2025-06-30',
              accumulation: 'YTD',
              accountingBasis: 'CAS',
              provenance: {
                ...makeFact().provenance,
                provider: 'eastmoney-financials',
                qualityTier: 'B',
                sourceField: 'TOTAL_OPERATE_INCOME',
                sourceUrl: 'https://emweb.eastmoney.com/',
              },
            }),
          ],
        }),
        makePeriod({
          id: 'period-q2-2025',
          fiscalYear: 2025,
          fiscalPeriodType: 'Q2',
          periodStartOn: '2025-04-01',
          periodEndOn: '2025-06-30',
          accountingBasis: 'CAS',
          publishedAt: '2025-08-20T00:00:00.000Z',
          facts: [
            makeFact({
              id: 'fact-revenue-q2-derived',
              value: '3000',
              currency: 'CNY',
              periodStartOn: '2025-04-01',
              periodEndOn: '2025-06-30',
              accumulation: 'discrete',
              accountingBasis: 'CAS',
              derivation: { kind: 'computed', formula: 'cn-discrete-quarter-v1', inputFactIds: ['fact-revenue-h1'] },
              provenance: {
                ...makeFact().provenance,
                provider: 'eastmoney-financials',
                qualityTier: 'B',
                sourceField: 'derived:Q2',
                sourceUrl: 'https://emweb.eastmoney.com/',
              },
            }),
          ],
        }),
      ],
    });
    const result = select(
      bundle,
      {
        market: 'CN',
        expectedPeriodEndOn: '2025-06-30',
        expectedPeriodType: 'H1',
        expectedAccountingBasis: 'CAS',
      },
    );
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') return;
    const revenue = result.facts.find((fact) => fact.metricCode === 'revenue')!;
    expect(revenue.value).toEqual({ kind: 'scalar', value: '6000' });
    expect(revenue.accumulation).toBe('YTD');
    expect(result.diagnostics.rejected.some((entry) => entry.reason === 'market_compat_rejected')).toBe(
      true,
    );
  });

  it('selects income discrete and cash flow YTD per metric for US Q2', () => {
    const bundle = makeBundle({
      periods: [
        makePeriod({
          id: 'period-q2-2025',
          fiscalYear: 2025,
          fiscalPeriodType: 'Q2',
          periodStartOn: '2025-04-01',
          periodEndOn: '2025-06-30',
          publishedAt: '2025-07-25T00:00:00.000Z',
          formType: '10-Q',
          facts: [
            makeFact({
              id: 'fact-revenue-q2',
              value: '4000',
              periodStartOn: '2025-04-01',
              periodEndOn: '2025-06-30',
              accumulation: 'discrete',
            }),
            makeFact({
              id: 'fact-ocf-q2',
              metricCode: 'operatingCashFlow',
              value: '1200',
              periodStartOn: '2025-01-01',
              periodEndOn: '2025-06-30',
              accumulation: 'YTD',
            }),
          ],
        }),
      ],
    });
    const result = select(bundle, {
      expectedPeriodEndOn: '2025-06-30',
      expectedPeriodType: 'Q2',
    });
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') return;
    const revenue = result.facts.find((fact) => fact.metricCode === 'revenue')!;
    const ocf = result.facts.find((fact) => fact.metricCode === 'operatingCashFlow')!;
    expect(revenue.accumulation).toBe('discrete');
    expect(ocf.accumulation).toBe('YTD');
  });

  it('prefers consolidated scope unless the event is explicitly parent', () => {
    const parentPeriod = makePeriod({
      id: 'period-parent',
      reportingScope: 'parent',
      facts: [makeFact({ reportingScope: 'parent' })],
    });
    const result = select(makeBundle({ periods: [parentPeriod] }));
    expect(result.status).toBe('pending');
    if (result.status === 'pending') {
      expect(result.reason).toBe('no_compatible_period');
    }

    const parentResult = select(makeBundle({ periods: [parentPeriod] }), {
      expectedScope: 'parent',
    });
    expect(parentResult.status).toBe('ready');
  });

  it('does not treat an unknown basis as equal to a requested basis', () => {
    const period = makePeriod({ accountingBasis: 'US-GAAP' });
    const result = select(makeBundle({ periods: [period] }), {
      expectedAccountingBasis: 'IFRS',
    });
    expect(result.status).toBe('pending');
    if (result.status === 'pending') {
      expect(result.reason).toBe('no_compatible_period');
    }
  });

  it('applies knowledge cutoff to per-fact revisions', () => {
    const older = makeFact({
      id: 'fact-revenue-older',
      value: '900',
      provenance: {
        ...makeFact().provenance,
        accessionNumber: 'acc-old',
        sourceFiledAt: '2025-01-10T00:00:00.000Z',
      },
    });
    const newer = makeFact({
      id: 'fact-revenue-newer',
      value: '1100',
      provenance: {
        ...makeFact().provenance,
        accessionNumber: 'acc-new',
        sourceFiledAt: '2025-01-20T00:00:00.000Z',
        sourceRevisionId: 'rev-2',
      },
    });
    const bundle = makeBundle({
      periods: [makePeriod({ publishedAt: '2025-01-05T00:00:00.000Z', facts: [older, newer] })],
    });

    const before = select(bundle, {
      knowledgeCutoffAt: '2025-01-15T00:00:00.000Z',
      now: '2025-01-15T00:00:00.000Z',
    });
    expect(before.status).toBe('ready');
    if (before.status !== 'ready') return;
    expect(before.facts[0].value).toEqual({ kind: 'scalar', value: '900' });

    const after = select(bundle, {
      knowledgeCutoffAt: '2025-01-25T00:00:00.000Z',
      now: '2025-01-25T00:00:00.000Z',
    });
    expect(after.status).toBe('ready');
    if (after.status !== 'ready') return;
    expect(after.facts[0].value).toEqual({ kind: 'scalar', value: '1100' });
  });

  it('returns ambiguous on same-tier provider conflicts', () => {
    const a = makePeriod({
      id: 'period-a',
      facts: [
        makeFact({
          id: 'fact-a',
          value: '1000',
          provenance: {
            ...makeFact().provenance,
            provider: 'eastmoney-a',
            qualityTier: 'B',
            sourceNature: 'aggregated_structured',
            sourceUrl: 'https://a.example.com/',
          },
        }),
      ],
    });
    const b = makePeriod({
      id: 'period-b',
      facts: [
        makeFact({
          id: 'fact-b',
          value: '1001',
          provenance: {
            ...makeFact().provenance,
            provider: 'eastmoney-b',
            qualityTier: 'B',
            sourceNature: 'aggregated_structured',
            sourceUrl: 'https://b.example.com/',
          },
        }),
      ],
    });
    const result = select(makeBundle({ periods: [a, b] }));
    expect(result.status).toBe('ambiguous');
  });

  it('resolves same-tier conflicts when values agree', () => {
    const a = makePeriod({
      id: 'period-a',
      facts: [
        makeFact({
          id: 'fact-a',
          provenance: {
            ...makeFact().provenance,
            provider: 'eastmoney-a',
            qualityTier: 'B',
            sourceNature: 'aggregated_structured',
            sourceUrl: 'https://a.example.com/',
          },
        }),
      ],
    });
    const b = makePeriod({
      id: 'period-b',
      facts: [
        makeFact({
          id: 'fact-b',
          provenance: {
            ...makeFact().provenance,
            provider: 'eastmoney-b',
            qualityTier: 'B',
            sourceNature: 'aggregated_structured',
            sourceUrl: 'https://b.example.com/',
          },
        }),
      ],
    });
    const result = select(makeBundle({ periods: [a, b] }));
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') return;
    expect(result.diagnostics.warnings.some((warning) => warning.includes('same-tier'))).toBe(true);
  });

  it('returns pending with a deterministic retryAt when the exact period is missing', () => {
    const bundle = makeBundle({
      instrumentId: 'CN:600519',
      periods: [makePeriod({ id: 'period-fy-2024', fiscalYear: 2024 })],
    });
    const result = select(bundle, {
      market: 'CN',
      expectedPeriodEndOn: '2025-06-30',
      expectedPeriodType: 'H1',
      expectedInstrumentId: 'CN:600519',
      now: '2025-02-01T00:00:00.000Z',
    });
    expect(result.status).toBe('pending');
    if (result.status !== 'pending') return;
    expect(result.reason).toBe('no_exact_period');
    expect(result.retryAt).toBe('2025-02-01T00:30:00.000Z');
  });

  it('uses a longer retry window for US', () => {
    const bundle = makeBundle({
      periods: [makePeriod({ id: 'period-fy-2024', fiscalYear: 2024 })],
    });
    const result = select(bundle, {
      expectedPeriodEndOn: '2025-03-31',
      expectedPeriodType: 'Q1',
      now: '2025-02-01T00:00:00.000Z',
    });
    expect(result.status).toBe('pending');
    if (result.status !== 'pending') return;
    expect(result.retryAt).toBe('2025-02-01T12:00:00.000Z');
  });

  it('never selects TTM periods', () => {
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
    const ttmFact = makeFact({
      id: 'fact-ttm',
      periodStartOn: '2024-01-01',
      periodEndOn: '2024-12-31',
      accumulation: 'TTM',
      derivation: {
        kind: 'computed',
        formula: 'ttm-v1',
        inputFactIds: ['q1', 'q2', 'q3', 'q4'],
      },
    });
    const bundle = makeBundle({
      periods: [
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
        makePeriod({
          id: 'period-ttm',
          fiscalPeriodType: 'TTM',
          periodStartOn: '2024-01-01',
          periodEndOn: '2025-12-31',
          facts: [ttmFact],
        }),
      ],
    });
    const result = select(bundle);
    expect(result.status).toBe('pending');
    if (result.status !== 'pending') return;
    expect(result.diagnostics.rejected.some((entry) => entry.reason === 'ttm_excluded')).toBe(true);
  });

  it('reports cross-period currency changes as warnings', () => {
    const bundle = makeBundle({
      periods: [
        makePeriod({
          id: 'period-q1-2025',
          fiscalYear: 2025,
          fiscalPeriodType: 'Q1',
          periodStartOn: '2025-01-01',
          periodEndOn: '2025-03-31',
          publishedAt: '2025-04-15T00:00:00.000Z',
          facts: [
            makeFact({
              id: 'fact-revenue-q1',
              value: '100',
              currency: 'CNY',
              periodStartOn: '2025-01-01',
              periodEndOn: '2025-03-31',
              accumulation: 'discrete',
            }),
          ],
        }),
      ],
    });
    const priorPeriodFacts = [
      {
        metricCode: 'revenue',
        periodKind: 'duration',
        accumulation: 'discrete',
        currency: 'USD',
      } as MetricFact,
    ];
    const result = select(bundle, {
      expectedPeriodEndOn: '2025-03-31',
      expectedPeriodType: 'Q1',
      priorPeriodFacts,
    });
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') return;
    expect(
      result.diagnostics.warnings.some((warning) => warning.includes('currency changed for revenue')),
    ).toBe(true);
  });

  it('rejects unsupported schema versions and instrument mismatches', () => {
    const unsupported = select({
      ...makeBundle(),
      schemaVersion: 'financials-v1',
    } as unknown as FinancialsBundleV2);
    expect(unsupported.status).toBe('unsupported');

    const mismatch = select(makeBundle(), { expectedInstrumentId: 'US:MSFT' });
    expect(mismatch.status).toBe('unsupported');
  });

  it('never returns ready for a mismatched period end', () => {
    const bundle = makeBundle({
      periods: [
        makePeriod(),
        makePeriod({
          id: 'period-q1-2025',
          fiscalYear: 2025,
          fiscalPeriodType: 'Q1',
          periodStartOn: '2025-01-01',
          periodEndOn: '2025-03-31',
          facts: [
            makeFact({
              id: 'fact-revenue-q1',
              periodStartOn: '2025-01-01',
              periodEndOn: '2025-03-31',
              accumulation: 'discrete',
            }),
          ],
        }),
      ],
    });
    for (const end of ['2025-06-30', '2025-09-30', '2024-12-31', '2025-12-30']) {
      const result = select(bundle, {
        expectedPeriodEndOn: end,
        expectedPeriodType: 'Q2',
      });
      if (result.status === 'ready') {
        expect(result.period.periodEndOn).toBe(end);
      }
    }
  });

  it('is insensitive to period array order (seeded property test)', () => {
    const baseline = makeBundle({
      periods: [
        makePeriod(),
        makePeriod({
          id: 'period-fy-2024',
          fiscalYear: 2024,
          facts: [makeFact({ id: 'fact-revenue-2024' })],
        }),
        makePeriod({
          id: 'period-q1-2025',
          fiscalYear: 2025,
          fiscalPeriodType: 'Q1',
          periodStartOn: '2025-01-01',
          periodEndOn: '2025-03-31',
          publishedAt: '2025-04-15T00:00:00.000Z',
          facts: [
            makeFact({
              id: 'fact-revenue-q1',
              value: '2500',
              periodStartOn: '2025-01-01',
              periodEndOn: '2025-03-31',
              accumulation: 'discrete',
              provenance: { ...makeFact().provenance, sourceFiledAt: '2025-04-15T00:00:00.000Z' },
            }),
          ],
        }),
      ],
    });
    const expected = select(baseline, {
      expectedPeriodEndOn: '2025-03-31',
      expectedPeriodType: 'Q1',
    });
    expect(expected.status).toBe('ready');
    if (expected.status !== 'ready') return;
    const expectedFactIds = expected.facts.map((fact) => fact.id).sort();

    let seed = 42;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0xffffffff;
    };
    for (let i = 0; i < 30; i += 1) {
      const shuffled = [...baseline.periods].sort(() => rand() - 0.5);
      const result = select(makeBundle({ periods: shuffled }), {
        expectedPeriodEndOn: '2025-03-31',
        expectedPeriodType: 'Q1',
      });
      expect(result.status).toBe('ready');
      if (result.status !== 'ready') continue;
      expect(result.facts.map((fact) => fact.id).sort()).toEqual(expectedFactIds);
      expect(result.period.id).toBe('period-q1-2025');
    }
  });

  it('is unaffected by inserting unrelated old periods (seeded property test)', () => {
    const base = makeBundle({
      periods: [
        makePeriod({
          id: 'period-q1-2025',
          fiscalYear: 2025,
          fiscalPeriodType: 'Q1',
          periodStartOn: '2025-01-01',
          periodEndOn: '2025-03-31',
          publishedAt: '2025-04-15T00:00:00.000Z',
          facts: [
            makeFact({
              id: 'fact-revenue-q1',
              value: '2500',
              periodStartOn: '2025-01-01',
              periodEndOn: '2025-03-31',
              accumulation: 'discrete',
              provenance: { ...makeFact().provenance, sourceFiledAt: '2025-04-15T00:00:00.000Z' },
            }),
          ],
        }),
      ],
    });
    const baseline = select(base, {
      expectedPeriodEndOn: '2025-03-31',
      expectedPeriodType: 'Q1',
    });
    expect(baseline.status).toBe('ready');
    if (baseline.status !== 'ready') return;
    const baselineIds = baseline.facts.map((fact) => fact.id).sort();

    const withOld = makeBundle({
      periods: [
        makePeriod({
          id: 'period-fy-2019',
          fiscalYear: 2019,
          facts: [makeFact({ id: 'fact-revenue-2019', value: '5' })],
        }),
        ...base.periods,
      ],
    });
    const result = select(withOld, {
      expectedPeriodEndOn: '2025-03-31',
      expectedPeriodType: 'Q1',
    });
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') return;
    expect(result.facts.map((fact) => fact.id).sort()).toEqual(baselineIds);
  });
});
