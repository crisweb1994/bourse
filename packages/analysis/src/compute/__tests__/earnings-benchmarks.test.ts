import { describe, expect, it } from 'vitest';
import type { MetricFact } from '../../contracts/earnings';
import {
  attachEarningsBenchmarks,
  computeConsensusComparison,
  computeGuidanceComparison,
  type ConsensusBenchmark,
  type GuidanceBenchmark,
} from '../earnings-benchmarks';

const FACT: MetricFact = {
  id: 'actual-eps',
  metricCode: 'epsBasic',
  value: { kind: 'scalar', value: '5.5' },
  normalizedValue: { kind: 'scalar', value: '5.5' },
  unit: 'per_share',
  currency: 'USD',
  scale: 1,
  periodStartOn: '2025-01-01',
  periodEndOn: '2025-12-31',
  periodKind: 'duration',
  accumulation: 'FY',
  accountingBasis: 'GAAP',
  consolidationScope: 'consolidated',
  derivation: { kind: 'reported' },
  provenance: {
    kind: 'filingSpan',
    filingId: 'filing-current',
    derivationId: 'derivation-current',
    contentHash: 'a'.repeat(64),
    quote: 'Basic EPS was $5.50.',
    startOffset: 0,
    endOffset: 20,
  },
  comparisons: [],
  checkStatus: { status: 'passed', checks: ['source_anchor'] },
  reconcileStatus: { status: 'pending' },
};

const GUIDANCE: GuidanceBenchmark = {
  metricCode: 'epsBasic',
  value: { kind: 'range', min: '5', max: '6' },
  unit: 'per_share',
  currency: 'USD',
  scale: 1,
  targetPeriodEndOn: '2025-12-31',
  targetPeriodType: 'FY',
  accountingBasis: 'GAAP',
  consolidationScope: 'consolidated',
  issuedAt: '2025-08-01T12:00:00.000Z',
  provider: 'sec-edgar',
  sourceUrl: 'https://example.com/guidance',
  sourceSpan: {
    kind: 'filingSpan',
    filingId: 'filing-guidance',
    derivationId: 'derivation-guidance',
    contentHash: 'b'.repeat(64),
    quote: 'We expect full-year EPS of $5 to $6.',
    startOffset: 10,
    endOffset: 50,
  },
};

const CONSENSUS: ConsensusBenchmark = {
  metricCode: 'epsBasic',
  value: { kind: 'scalar', value: '5' },
  unit: 'per_share',
  currency: 'USD',
  periodEndOn: '2025-12-31',
  periodType: 'FY',
  asOf: '2026-01-20T12:00:00.000Z',
  capturedAt: '2026-01-20T12:05:00.000Z',
  provider: 'yahoo',
  sourceUrl: 'https://example.com/consensus',
};

describe('earnings benchmarks', () => {
  it('computes guidance outcome without combining it with consensus', () => {
    const comparison = computeGuidanceComparison(FACT, GUIDANCE, '2026-02-01T12:00:00.000Z');
    expect(comparison).toMatchObject({
      kind: 'GUIDANCE',
      outcome: 'within',
      referenceValue: { kind: 'range', min: '5', max: '6' },
    });
  });

  it('rejects guidance issued at or after the filing publication time', () => {
    expect(computeGuidanceComparison(
      FACT,
      { ...GUIDANCE, issuedAt: '2026-02-01T12:00:00.000Z' },
      '2026-02-01T12:00:00.000Z',
    )).toBeNull();
  });

  it('requires both consensus asOf and capture time to precede publication', () => {
    expect(computeConsensusComparison(
      FACT,
      { ...CONSENSUS, capturedAt: '2026-02-02T12:00:00.000Z' },
      '2026-02-01T12:00:00.000Z',
      30 * 24 * 60 * 60_000,
    )).toBeNull();
  });

  it('drops stale consensus and keeps guidance and consensus as separate rows', () => {
    const filingPublishedAt = '2026-02-01T12:00:00.000Z';
    const fresh = attachEarningsBenchmarks({
      facts: [FACT],
      periodType: 'FY',
      filingPublishedAt,
      guidance: [GUIDANCE],
      consensus: [CONSENSUS],
      consensusMaxAgeMs: 30 * 24 * 60 * 60_000,
    });
    expect(fresh[0].comparisons.map((comparison) => comparison.kind)).toEqual(['GUIDANCE', 'CONSENSUS']);

    const stale = attachEarningsBenchmarks({
      facts: [FACT],
      periodType: 'FY',
      filingPublishedAt,
      guidance: [GUIDANCE],
      consensus: [{ ...CONSENSUS, asOf: '2025-01-01T00:00:00.000Z' }],
      consensusMaxAgeMs: 30 * 24 * 60 * 60_000,
    });
    expect(stale[0].comparisons.map((comparison) => comparison.kind)).toEqual(['GUIDANCE']);
  });

  it('does not compare annual guidance on a quarterly card', () => {
    const result = attachEarningsBenchmarks({
      facts: [FACT],
      periodType: 'Q1',
      filingPublishedAt: '2026-02-01T12:00:00.000Z',
      guidance: [GUIDANCE],
      consensus: [],
      consensusMaxAgeMs: 30 * 24 * 60 * 60_000,
    });
    expect(result[0].comparisons).toEqual([]);
  });
});
