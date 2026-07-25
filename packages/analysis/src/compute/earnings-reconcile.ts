import Decimal from 'decimal.js';
import type { MetricFact, MetricValue } from '../contracts/earnings';

export interface ReconcileEarningsFactsOptions {
  relativeTolerance?: number;
  absoluteTolerance?: string;
}

export function reconcileEarningsFacts(
  filingFacts: MetricFact[],
  structuredFacts: MetricFact[],
  options: ReconcileEarningsFactsOptions = {},
): MetricFact[] {
  return filingFacts.map((fact) => {
    const comparison = structuredFacts.find((candidate) => comparableIdentity(fact, candidate));
    if (!comparison || comparison.provenance.kind !== 'structuredSource') return fact;

    const result = compareValues(
      fact.normalizedValue ?? fact.value,
      comparison.normalizedValue ?? comparison.value,
      options.relativeTolerance ?? 0.001,
      options.absoluteTolerance ?? '1',
    );
    if (!result) return fact;

    if (result.matches) {
      return {
        ...fact,
        reconcileStatus: {
          status: 'reconciled' as const,
          comparedWith: comparison.provenance,
          delta: result.delta,
        },
      };
    }
    return {
      ...fact,
      reconcileStatus: {
        status: 'conflicted' as const,
        comparedWith: comparison.provenance,
        sourceValue: fact.normalizedValue ?? fact.value,
        structuredValue: comparison.normalizedValue ?? comparison.value,
        delta: result.delta,
      },
    };
  });
}

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

function compareValues(
  filing: MetricValue,
  structured: MetricValue,
  relativeTolerance: number,
  absoluteTolerance: string,
): { matches: boolean; delta: string } | null {
  if (filing.kind === 'range' && structured.kind === 'scalar') {
    const value = new Decimal(structured.value);
    const min = new Decimal(filing.min);
    const max = new Decimal(filing.max);
    const delta = value.lt(min) ? value.sub(min) : value.gt(max) ? value.sub(max) : new Decimal(0);
    return { matches: value.gte(min) && value.lte(max), delta: delta.toString() };
  }
  if (filing.kind !== 'scalar' || structured.kind !== 'scalar') return null;

  const left = new Decimal(filing.value);
  const right = new Decimal(structured.value);
  const delta = left.sub(right);
  const tolerance = Decimal.max(
    new Decimal(absoluteTolerance),
    Decimal.max(left.abs(), right.abs()).mul(relativeTolerance),
  );
  return { matches: delta.abs().lte(tolerance), delta: delta.toString() };
}
