import Decimal from 'decimal.js';
import type { EarningsComparison, MetricFact } from '../contracts/earnings';
import { comparableIdentity } from './earnings-reconcile';

export function computePeriodComparison(
  current: MetricFact,
  prior: MetricFact,
  kind: 'YOY' | 'QOQ' | 'PREVIOUS_VERSION',
): EarningsComparison | null {
  const alignedPrior: MetricFact = {
    ...prior,
    periodStartOn: current.periodStartOn,
    periodEndOn: current.periodEndOn,
  };
  if (!comparableIdentity(current, alignedPrior)) return null;
  const currentValue = current.normalizedValue ?? current.value;
  const priorValue = prior.normalizedValue ?? prior.value;
  if (kind === 'PREVIOUS_VERSION' && currentValue.kind === 'scalar' && priorValue.kind === 'range') {
    const now = new Decimal(currentValue.value);
    const min = new Decimal(priorValue.min);
    const max = new Decimal(priorValue.max);
    const outcome = now.lt(min) ? 'below' : now.gt(max) ? 'above' : 'within';
    const absoluteDelta = outcome === 'below'
      ? now.sub(min).toString()
      : outcome === 'above'
        ? now.sub(max).toString()
        : '0';
    return {
      kind,
      label: '较预告',
      referenceValue: priorValue,
      outcome,
      absoluteDelta,
    };
  }
  if (currentValue.kind !== 'scalar' || priorValue.kind !== 'scalar') return null;
  const previous = new Decimal(priorValue.value);
  const now = new Decimal(currentValue.value);
  const absoluteDelta = now.sub(previous);
  const percentDelta = previous.lte(0)
    ? undefined
    : absoluteDelta.div(previous).mul(100).toDecimalPlaces(6).toString();
  return {
    kind,
    label: kind === 'YOY' ? '同比' : kind === 'QOQ' ? '环比' : '较上一版本',
    absoluteDelta: absoluteDelta.toString(),
    ...(percentDelta ? { percentDelta } : {}),
  };
}

export function attachComparisons(
  currentFacts: MetricFact[],
  priorFacts: MetricFact[],
  kind: 'YOY' | 'QOQ' | 'PREVIOUS_VERSION',
): MetricFact[] {
  return currentFacts.map((fact) => {
    const prior = priorFacts.find((candidate) => candidate.metricCode === fact.metricCode);
    if (!prior) return fact;
    const comparison = computePeriodComparison(fact, prior, kind);
    return comparison
      ? { ...fact, comparisons: [...fact.comparisons, comparison] }
      : fact;
  });
}
