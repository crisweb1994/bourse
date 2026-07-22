import Decimal from 'decimal.js';
import type { z } from 'zod';
import { FilingSpanSchema, type EarningsComparison, type EarningsMetricCode, type MetricFact, type MetricValue } from '../contracts/earnings';

type FilingSpan = z.infer<typeof FilingSpanSchema>;

export interface GuidanceBenchmark {
  metricCode: EarningsMetricCode;
  value: Extract<MetricValue, { kind: 'range' }>;
  unit: MetricFact['unit'];
  currency?: string;
  scale: number;
  targetPeriodEndOn: string;
  targetPeriodType: 'FY';
  accountingBasis: string;
  consolidationScope: MetricFact['consolidationScope'];
  issuedAt: string;
  provider: string;
  sourceUrl: string;
  sourceSpan: FilingSpan;
}

export interface ConsensusBenchmark {
  metricCode: EarningsMetricCode;
  value: Extract<MetricValue, { kind: 'scalar' }>;
  unit: MetricFact['unit'];
  currency?: string;
  periodEndOn: string;
  periodType: string;
  asOf: string;
  capturedAt: string;
  provider: string;
  sourceUrl: string;
}

export interface AttachEarningsBenchmarksInput {
  facts: MetricFact[];
  periodType: string;
  filingPublishedAt: string;
  guidance: GuidanceBenchmark[];
  consensus: ConsensusBenchmark[];
  consensusMaxAgeMs: number;
}

export function attachEarningsBenchmarks(input: AttachEarningsBenchmarksInput): MetricFact[] {
  return input.facts.map((fact) => {
    const comparisons = [...fact.comparisons];
    if (input.periodType === 'FY') {
      const guidance = latestBefore(
        input.guidance.filter((candidate) => guidanceMatches(fact, candidate)),
        input.filingPublishedAt,
        (candidate) => candidate.issuedAt,
      );
      const comparison = guidance
        ? computeGuidanceComparison(fact, guidance, input.filingPublishedAt)
        : null;
      if (comparison) comparisons.push(comparison);
    }

    const consensus = latestBefore(
      input.consensus.filter((candidate) => consensusMatches(fact, input.periodType, candidate)),
      input.filingPublishedAt,
      (candidate) => candidate.asOf,
      (candidate) => candidate.capturedAt,
    );
    const consensusComparison = consensus
      ? computeConsensusComparison(fact, consensus, input.filingPublishedAt, input.consensusMaxAgeMs)
      : null;
    if (consensusComparison) comparisons.push(consensusComparison);
    return { ...fact, comparisons };
  });
}

export function computeGuidanceComparison(
  fact: MetricFact,
  guidance: GuidanceBenchmark,
  filingPublishedAt: string,
): EarningsComparison | null {
  if (!guidanceMatches(fact, guidance) || !strictlyBefore(guidance.issuedAt, filingPublishedAt)) return null;
  const actual = scalarValue(fact.normalizedValue ?? fact.value);
  if (!actual) return null;
  const min = new Decimal(guidance.value.min).mul(guidance.scale);
  const max = new Decimal(guidance.value.max).mul(guidance.scale);
  const outcome = actual.lt(min) ? 'below' : actual.gt(max) ? 'above' : 'within';
  const absoluteDelta = outcome === 'below'
    ? actual.sub(min).toString()
    : outcome === 'above'
      ? actual.sub(max).toString()
      : '0';
  return {
    kind: 'GUIDANCE',
    label: 'vs 指引',
    referenceValue: { kind: 'range', min: min.toString(), max: max.toString() },
    outcome,
    absoluteDelta,
    asOf: guidance.issuedAt,
    provider: guidance.provider,
    sourceUrl: guidance.sourceUrl,
    sourceSpan: guidance.sourceSpan,
  };
}

export function computeConsensusComparison(
  fact: MetricFact,
  consensus: ConsensusBenchmark,
  filingPublishedAt: string,
  maxAgeMs: number,
): EarningsComparison | null {
  if (!consensusMatches(fact, '', consensus, true)) return null;
  if (!strictlyBefore(consensus.asOf, filingPublishedAt) || !strictlyBefore(consensus.capturedAt, filingPublishedAt)) return null;
  const publishedAt = new Date(filingPublishedAt).getTime();
  const asOf = new Date(consensus.asOf).getTime();
  if (!Number.isFinite(publishedAt) || !Number.isFinite(asOf) || publishedAt - asOf > maxAgeMs) return null;
  const actual = scalarValue(fact.normalizedValue ?? fact.value);
  const reference = new Decimal(consensus.value.value);
  if (!actual) return null;
  const delta = actual.sub(reference);
  return {
    kind: 'CONSENSUS',
    label: 'vs 共识',
    referenceValue: consensus.value,
    absoluteDelta: delta.toString(),
    ...(reference.gt(0) ? { percentDelta: delta.div(reference).mul(100).toDecimalPlaces(6).toString() } : {}),
    asOf: consensus.asOf,
    provider: consensus.provider,
    sourceUrl: consensus.sourceUrl,
  };
}

function guidanceMatches(fact: MetricFact, guidance: GuidanceBenchmark): boolean {
  return fact.metricCode === guidance.metricCode
    && fact.periodEndOn === guidance.targetPeriodEndOn
    && fact.accumulation === 'FY'
    && fact.unit === guidance.unit
    && fact.currency === guidance.currency
    && fact.accountingBasis === guidance.accountingBasis
    && fact.consolidationScope === guidance.consolidationScope;
}

function consensusMatches(fact: MetricFact, periodType: string, consensus: ConsensusBenchmark, ignorePeriodType = false): boolean {
  return fact.metricCode === consensus.metricCode
    && fact.periodEndOn === consensus.periodEndOn
    && (ignorePeriodType || consensus.periodType === periodType || (consensus.periodType === 'QUARTER' && /^Q[1-3]$/.test(periodType)))
    && fact.unit === consensus.unit
    && fact.currency === consensus.currency;
}

function latestBefore<T>(values: T[], before: string, ...dateSelectors: Array<(value: T) => string>): T | undefined {
  return values
    .filter((value) => dateSelectors.every((selector) => strictlyBefore(selector(value), before)))
    .sort((left, right) => new Date(dateSelectors[0](right)).getTime() - new Date(dateSelectors[0](left)).getTime())[0];
}

function strictlyBefore(left: string, right: string): boolean {
  const leftTime = new Date(left).getTime();
  const rightTime = new Date(right).getTime();
  return Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime < rightTime;
}

function scalarValue(value: MetricValue): Decimal | null {
  return value.kind === 'scalar' ? new Decimal(value.value) : null;
}
