import Decimal from 'decimal.js';
import type { MetricFact, MetricValue } from '../../contracts/earnings';
import { verifyEarningsCandidates } from '../../compute/earnings-verify';
import {
  EarningsEvalFixtureSchema,
  type EarningsEvalFixture,
  type EarningsEvalMetrics,
} from './types';

export interface EarningsEvalResult {
  metrics: EarningsEvalMetrics;
  splits: Record<'development' | 'blind', EarningsEvalMetrics>;
  strata: Array<{
    market: 'US' | 'CN';
    formType: string;
    metrics: EarningsEvalMetrics;
  }>;
  gate: {
    passed: boolean;
    blindFalseAcceptedFacts: number;
    blindCoverage: number;
    minimumCoverage: number;
  };
  documents: Array<{
    id: string;
    market: 'US' | 'CN';
    split: 'development' | 'blind';
    formType: string;
    eligibleFacts: number;
    visibleFacts: number;
    correctVisibleFacts: number;
    falseAcceptedFacts: number;
    rejectedFacts: number;
    rejectionReasons: Record<string, number>;
    acceptedFacts: Array<{
      metricCode: MetricFact['metricCode'];
      normalizedValue: MetricValue;
      correct: boolean;
    }>;
    rejectedCandidates: Array<{
      metricCode: string | null;
      reasons: string[];
      sourceQuote: string | null;
    }>;
  }>;
}

export function runEarningsEval(rawFixtures: unknown[]): EarningsEvalResult {
  const fixtures = rawFixtures.map((fixture) => EarningsEvalFixtureSchema.parse(fixture));
  const documents = fixtures.map(runFixture);
  const blind = metricsFor(documents.filter((item) => item.split === 'blind'));
  const groups = new Map<string, typeof documents>();
  for (const document of documents) {
    const key = `${document.market}:${document.formType}`;
    groups.set(key, [...(groups.get(key) ?? []), document]);
  }
  return {
    metrics: metricsFor(documents),
    splits: {
      development: metricsFor(documents.filter((item) => item.split === 'development')),
      blind,
    },
    strata: [...groups.values()].map((items) => ({
      market: items[0].market,
      formType: items[0].formType,
      metrics: metricsFor(items),
    })),
    gate: {
      passed: blind.falseAcceptedFacts === 0 && blind.coverage >= 0.8,
      blindFalseAcceptedFacts: blind.falseAcceptedFacts,
      blindCoverage: blind.coverage,
      minimumCoverage: 0.8,
    },
    documents,
  };
}

function runFixture(fixture: EarningsEvalFixture) {
  const result = verifyEarningsCandidates({
    candidates: fixture.candidates,
    derivation: fixture.derivation,
    event: fixture.event,
  });
  const eligible = fixture.goldFacts.filter((fact) => fact.eligible);
  // Only metrics with a reviewed gold fact are in scope for scoring. Once a
  // candidate claims an in-scope metric, however, every visible instance is
  // scored: a wrong period/unit/basis must count as a false acceptance rather
  // than disappearing because its identity does not exactly match gold.
  const scoredFacts = result.facts.filter((fact) => (
    eligible.some((gold) => fact.metricCode === gold.metricCode)
  ));
  let correctVisibleFacts = 0;
  let falseAcceptedFacts = 0;
  const acceptedFacts: EarningsEvalResult['documents'][number]['acceptedFacts'] = [];
  for (const fact of scoredFacts) {
    const gold = eligible.find((candidate) => sameIdentity(fact, candidate));
    const correct = Boolean(
      gold
      && sameValue(fact.normalizedValue ?? fact.value, gold.normalizedValue)
    );
    acceptedFacts.push({
      metricCode: fact.metricCode,
      normalizedValue: fact.normalizedValue ?? fact.value,
      correct,
    });
    if (correct) {
      correctVisibleFacts += 1;
    } else {
      falseAcceptedFacts += 1;
    }
  }
  const rejectionReasons: Record<string, number> = {};
  for (const rejected of result.rejected) {
    for (const reason of rejected.reasons) {
      rejectionReasons[reason] = (rejectionReasons[reason] ?? 0) + 1;
    }
  }
  return {
    id: fixture.meta.id,
    market: fixture.meta.market,
    split: fixture.meta.split,
    formType: fixture.meta.formType,
    eligibleFacts: eligible.length,
    visibleFacts: scoredFacts.length,
    correctVisibleFacts,
    falseAcceptedFacts,
    rejectedFacts: result.rejected.length,
    rejectionReasons,
    acceptedFacts,
    rejectedCandidates: result.rejected.map((rejected) => {
      const raw = rejected.candidate ?? (
        rejected.rawCandidate && typeof rejected.rawCandidate === 'object' && !Array.isArray(rejected.rawCandidate)
          ? rejected.rawCandidate as Record<string, unknown>
          : null
      );
      return {
        metricCode: raw && typeof raw.metricCode === 'string' ? raw.metricCode : null,
        reasons: rejected.reasons,
        sourceQuote: raw && typeof raw.sourceQuote === 'string' ? raw.sourceQuote : null,
      };
    }),
  };
}

function metricsFor(documents: EarningsEvalResult['documents']): EarningsEvalMetrics {
  const totals = documents.reduce(
    (sum, item) => ({
      eligibleFacts: sum.eligibleFacts + item.eligibleFacts,
      visibleFacts: sum.visibleFacts + item.visibleFacts,
      correctVisibleFacts: sum.correctVisibleFacts + item.correctVisibleFacts,
      falseAcceptedFacts: sum.falseAcceptedFacts + item.falseAcceptedFacts,
    }),
    { eligibleFacts: 0, visibleFacts: 0, correctVisibleFacts: 0, falseAcceptedFacts: 0 },
  );
  return {
    documents: documents.length,
    ...totals,
    coverage: ratio(totals.correctVisibleFacts, totals.eligibleFacts),
    visiblePrecision: ratio(totals.correctVisibleFacts, totals.visibleFacts),
    falseAcceptanceRate: ratio(totals.falseAcceptedFacts, totals.visibleFacts),
    falseAcceptanceUpper95: wilsonUpper(totals.falseAcceptedFacts, totals.visibleFacts),
  };
}

function sameIdentity(fact: MetricFact, gold: EarningsEvalFixture['goldFacts'][number]): boolean {
  return (
    fact.metricCode === gold.metricCode &&
    fact.unit === gold.unit &&
    fact.currency === gold.currency &&
    fact.periodStartOn === gold.periodStartOn &&
    fact.periodEndOn === gold.periodEndOn &&
    fact.accumulation === gold.accumulation &&
    fact.accountingBasis === gold.accountingBasis &&
    fact.consolidationScope === gold.consolidationScope
  );
}

function sameValue(left: MetricValue, right: MetricValue): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'scalar' && right.kind === 'scalar') {
    return new Decimal(left.value).eq(right.value);
  }
  if (left.kind === 'range' && right.kind === 'range') {
    return new Decimal(left.min).eq(right.min) && new Decimal(left.max).eq(right.max);
  }
  return false;
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function wilsonUpper(successes: number, total: number): number {
  if (total === 0) return 1;
  const z = 1.959963984540054;
  const p = successes / total;
  const z2 = z * z;
  const center = p + z2 / (2 * total);
  const radius = z * Math.sqrt((p * (1 - p) + z2 / (4 * total)) / total);
  return Math.min(1, (center + radius) / (1 + z2 / total));
}
