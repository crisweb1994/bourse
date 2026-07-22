import { describe, expect, it } from 'vitest';
import { MetricFactSchema, type MetricFact } from '../../contracts/earnings';
import { computePeriodComparison } from '../earnings-diff';
import { reconcileEarningsFacts } from '../earnings-reconcile';

function fact(value: string, provenance: MetricFact['provenance']): MetricFact {
  return MetricFactSchema.parse({
    id: `${provenance.kind}-${value}`,
    metricCode: 'revenue',
    value: { kind: 'scalar', value },
    normalizedValue: { kind: 'scalar', value },
    unit: 'currency',
    currency: 'CNY',
    scale: 1,
    periodStartOn: '2026-01-01',
    periodEndOn: '2026-06-30',
    periodKind: 'duration',
    accumulation: 'YTD',
    accountingBasis: 'CAS',
    consolidationScope: 'consolidated',
    derivation: { kind: 'reported' },
    provenance,
    comparisons: [],
    checkStatus: { status: 'passed', checks: [] },
    reconcileStatus: { status: 'pending' },
  });
}

const filingProvenance: MetricFact['provenance'] = {
  kind: 'filingSpan',
  filingId: 'f1',
  derivationId: 'd1',
  contentHash: 'a'.repeat(64),
  quote: 'Revenue 100',
  startOffset: 0,
  endOffset: 11,
};
const structuredProvenance: MetricFact['provenance'] = {
  kind: 'structuredSource',
  provider: 'eastmoney-financials',
  sourceUrl: 'https://example.com/data',
  fieldPath: 'income.revenue',
  asOf: '2026-07-19T00:00:00.000Z',
};

describe('reconcileEarningsFacts', () => {
  it('reconciles within tolerance without replacing the filing value', () => {
    const result = reconcileEarningsFacts(
      [fact('10000000000', filingProvenance)],
      [fact('10000000001', structuredProvenance)],
    );
    expect(result[0].value).toEqual({ kind: 'scalar', value: '10000000000' });
    expect(result[0].reconcileStatus.status).toBe('reconciled');
  });

  it('keeps both values when they conflict', () => {
    const result = reconcileEarningsFacts(
      [fact('100', filingProvenance)],
      [fact('120', structuredProvenance)],
      { relativeTolerance: 0.001, absoluteTolerance: '1' },
    );
    expect(result[0].reconcileStatus).toMatchObject({
      status: 'conflicted',
      sourceValue: { value: '100' },
      structuredValue: { value: '120' },
    });
  });
});

describe('computePeriodComparison', () => {
  it('omits percent change for a non-positive base', () => {
    const comparison = computePeriodComparison(
      fact('10', filingProvenance),
      fact('-5', filingProvenance),
      'YOY',
    );
    expect(comparison?.absoluteDelta).toBe('15');
    expect(comparison?.percentDelta).toBeUndefined();
  });
});
