/**
 * plan-v2 Wave 0 — fixture judge.
 *
 * Load a (raw fixture, expected fixture) pair, replay raw facts through
 * compute layer (via fetchSnapshot with stub fetchers that return the
 * vendored data), then diff against the expected file. Diffs above
 * NUMERIC_TOLERANCE (0.5%) or any label/count mismatch are flagged.
 *
 * Pure functional — no I/O. Caller (CLI or test runner) is responsible
 * for loading JSON files and producing the inputs.
 */

import { createHash } from 'node:crypto';
import {
  computeFinancialRatios,
  computeTechnicalIndicators,
  computeValuation,
  detectRedFlags,
} from '../compute';
import type { FinancialsBundle } from '../ports/financials';
import type { PriceBar, Quote } from '../ports/finance';
import {
  NUMERIC_TOLERANCE,
  type ExpectedComputedFacts,
  type ExpectedFixture,
  type JudgeRunResult,
  type RawFixture,
} from './types';

// ============================================================================
// Hashing — guards against fixture drift
// ============================================================================

export function hashRawFixture(raw: RawFixture): string {
  // Canonical JSON: sort keys recursively so re-serialised fixture
  // produces stable hash. Excludes meta.vendoredAt so re-vendoring the
  // same data on a different day doesn't invalidate cached hashes.
  const { meta, ...rest } = raw;
  const canonical = canonicalize({ ...rest, meta: { ...meta, vendoredAt: '' } });
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex').slice(0, 16);
}

function canonicalize(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonicalize);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(v as Record<string, unknown>).sort()) {
      out[key] = canonicalize((v as Record<string, unknown>)[key]);
    }
    return out;
  }
  return v;
}

// ============================================================================
// Compute replay
// ============================================================================

/**
 * Replay the compute layer against a fixture's raw facts. Returns
 * exactly the subset the judge diffs (mirrors ExpectedComputedFacts).
 *
 * We don't go through fetchSnapshot here because (a) it adds timer
 * scheduling that's irrelevant for offline replay, and (b) the fixture
 * stores the raw data already-deserialized so direct calls into
 * compute helpers are cleaner. The integration test suite covers the
 * fetchSnapshot orchestration separately.
 */
export function replayCompute(raw: RawFixture): ExpectedComputedFacts {
  const quote = (raw.rawFacts.quote ?? null) as Quote | null;
  const financials = (raw.rawFacts.financials ?? null) as FinancialsBundle | null;
  const history = (raw.rawFacts.history ?? null) as PriceBar[] | null;
  const market = raw.meta.market;

  const ratiosOut = computeFinancialRatios({
    bundle: financials,
    quote,
    market,
  });
  const techOut = computeTechnicalIndicators({ bars: history ?? [] });
  const redFlags = detectRedFlags({ bundle: financials, ratios: ratiosOut.ratios });
  const valuationOut = computeValuation({
    bundle: financials,
    quote,
    history,
    market,
  });

  return {
    ratios: ratiosOut.ratios
      ? {
          pe: ratiosOut.ratios.pe,
          pb: ratiosOut.ratios.pb,
          ps: ratiosOut.ratios.ps,
          grossMargin: ratiosOut.ratios.grossMargin,
          netMargin: ratiosOut.ratios.netMargin,
          roe: ratiosOut.ratios.roe,
          fcfYield: ratiosOut.ratios.fcfYield,
        }
      : null,
    technicalIndicators: techOut.indicators
      ? {
          sma20: techOut.indicators.sma20,
          sma50: techOut.indicators.sma50,
          sma200: techOut.indicators.sma200,
          rsi14: techOut.indicators.rsi14,
          macdTrend: techOut.indicators.macdTrend,
          trend: techOut.indicators.trend,
        }
      : null,
    redFlagsCount: redFlags.length,
    redFlagRules: redFlags.map((f) => f.rule).sort(),
    valuation: valuationOut.valuation
      ? {
          marketCap: valuationOut.valuation.marketCap,
          impliedGrowthRate: valuationOut.valuation.impliedGrowthRate,
          pe5yPercentile: valuationOut.valuation.pe5yPercentile,
        }
      : null,
    availability: {
      available: [...raw.dataAvailability.available].sort(),
      missingCount: raw.dataAvailability.missing.length,
    },
  };
}

// ============================================================================
// Diff
// ============================================================================

/**
 * Run a fixture through compute, diff against expected. `ok=true` when
 * no diffs registered.
 */
export function judgeFixture(
  raw: RawFixture,
  expected: ExpectedFixture,
): JudgeRunResult {
  const diffs: JudgeRunResult['diffs'] = [];

  // Guard against fixture drift — if rawHash mismatches, regenerate
  // expected via `pnpm eval:lock` rather than silently passing wrong data.
  const actualHash = hashRawFixture(raw);
  if (actualHash !== expected.rawHash) {
    diffs.push({
      path: 'rawHash',
      expected: expected.rawHash,
      actual: actualHash,
      note: 'Fixture raw data changed since expected was locked. Re-run with eval:lock to update.',
    });
  }

  const actual = replayCompute(raw);
  const exp = expected.computedFacts;

  // ratios
  if ((actual.ratios === null) !== (exp.ratios === null)) {
    diffs.push({ path: 'ratios', expected: exp.ratios, actual: actual.ratios });
  } else if (actual.ratios && exp.ratios) {
    diffNumeric('ratios.pe', exp.ratios.pe, actual.ratios.pe, diffs);
    diffNumeric('ratios.pb', exp.ratios.pb, actual.ratios.pb, diffs);
    diffNumeric('ratios.ps', exp.ratios.ps, actual.ratios.ps, diffs);
    diffNumeric('ratios.grossMargin', exp.ratios.grossMargin, actual.ratios.grossMargin, diffs);
    diffNumeric('ratios.netMargin', exp.ratios.netMargin, actual.ratios.netMargin, diffs);
    diffNumeric('ratios.roe', exp.ratios.roe, actual.ratios.roe, diffs);
    diffNumeric('ratios.fcfYield', exp.ratios.fcfYield, actual.ratios.fcfYield, diffs);
  }

  // technical
  if ((actual.technicalIndicators === null) !== (exp.technicalIndicators === null)) {
    diffs.push({
      path: 'technicalIndicators',
      expected: exp.technicalIndicators,
      actual: actual.technicalIndicators,
    });
  } else if (actual.technicalIndicators && exp.technicalIndicators) {
    diffNumeric('tech.sma20', exp.technicalIndicators.sma20, actual.technicalIndicators.sma20, diffs);
    diffNumeric('tech.sma50', exp.technicalIndicators.sma50, actual.technicalIndicators.sma50, diffs);
    diffNumeric('tech.sma200', exp.technicalIndicators.sma200, actual.technicalIndicators.sma200, diffs);
    diffNumeric('tech.rsi14', exp.technicalIndicators.rsi14, actual.technicalIndicators.rsi14, diffs);
    if (actual.technicalIndicators.macdTrend !== exp.technicalIndicators.macdTrend) {
      diffs.push({
        path: 'tech.macdTrend',
        expected: exp.technicalIndicators.macdTrend,
        actual: actual.technicalIndicators.macdTrend,
      });
    }
    if (actual.technicalIndicators.trend !== exp.technicalIndicators.trend) {
      diffs.push({
        path: 'tech.trend',
        expected: exp.technicalIndicators.trend,
        actual: actual.technicalIndicators.trend,
      });
    }
  }

  // red flags
  if (actual.redFlagsCount !== exp.redFlagsCount) {
    diffs.push({
      path: 'redFlagsCount',
      expected: exp.redFlagsCount,
      actual: actual.redFlagsCount,
    });
  }
  // Rule list compared as sorted sets
  if (JSON.stringify(actual.redFlagRules) !== JSON.stringify(exp.redFlagRules)) {
    diffs.push({
      path: 'redFlagRules',
      expected: exp.redFlagRules,
      actual: actual.redFlagRules,
    });
  }

  // valuation
  if ((actual.valuation === null) !== (exp.valuation === null)) {
    diffs.push({ path: 'valuation', expected: exp.valuation, actual: actual.valuation });
  } else if (actual.valuation && exp.valuation) {
    diffNumeric('val.marketCap', exp.valuation.marketCap, actual.valuation.marketCap, diffs);
    diffNumeric('val.impliedGrowthRate', exp.valuation.impliedGrowthRate, actual.valuation.impliedGrowthRate, diffs);
    diffNumeric('val.pe5yPercentile', exp.valuation.pe5yPercentile, actual.valuation.pe5yPercentile, diffs);
  }

  // availability
  if (
    JSON.stringify(actual.availability.available) !==
    JSON.stringify(exp.availability.available)
  ) {
    diffs.push({
      path: 'availability.available',
      expected: exp.availability.available,
      actual: actual.availability.available,
    });
  }
  if (actual.availability.missingCount !== exp.availability.missingCount) {
    diffs.push({
      path: 'availability.missingCount',
      expected: exp.availability.missingCount,
      actual: actual.availability.missingCount,
    });
  }

  return { id: raw.meta.id, ok: diffs.length === 0, diffs };
}

function diffNumeric(
  path: string,
  expected: number | null,
  actual: number | null,
  diffs: JudgeRunResult['diffs'],
): void {
  if (expected === null && actual === null) return;
  if (expected === null || actual === null) {
    diffs.push({ path, expected, actual });
    return;
  }
  if (!Number.isFinite(expected) || !Number.isFinite(actual)) {
    diffs.push({ path, expected, actual, note: 'non-finite value' });
    return;
  }
  // Absolute tolerance for values near zero; relative for the rest
  const absDelta = Math.abs(actual - expected);
  const denom = Math.max(Math.abs(expected), 1e-6);
  const relDelta = absDelta / denom;
  if (relDelta > NUMERIC_TOLERANCE && absDelta > 1e-6) {
    diffs.push({
      path,
      expected,
      actual,
      note: `delta=${(relDelta * 100).toFixed(2)}% (tolerance ${(NUMERIC_TOLERANCE * 100).toFixed(2)}%)`,
    });
  }
}

// ============================================================================
// Lock (generate expected from raw)
// ============================================================================

/**
 * Produce an ExpectedFixture from a raw fixture by running the current
 * compute layer. Used by `pnpm eval:lock` when fixtures are first added
 * or intentionally updated.
 */
export function lockExpected(raw: RawFixture): ExpectedFixture {
  return {
    id: raw.meta.id,
    rawHash: hashRawFixture(raw),
    computedFacts: replayCompute(raw),
  };
}
