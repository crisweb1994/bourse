import type { MetricFact } from '../contracts/earnings';

export function comparableIdentity(a: MetricFact, b: MetricFact): boolean {
  return (
    a.metricCode === b.metricCode &&
    a.periodStartOn === b.periodStartOn &&
    a.periodEndOn === b.periodEndOn &&
    a.periodKind === b.periodKind &&
    a.accumulation === b.accumulation &&
    a.accountingBasis === b.accountingBasis &&
    a.consolidationScope === b.consolidationScope &&
    a.unit === b.unit &&
    a.currency === b.currency
  );
}
