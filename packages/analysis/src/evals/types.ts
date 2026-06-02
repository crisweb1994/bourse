/**
 * plan-v2 Wave 0 — fixture & eval types.
 *
 * A fixture freezes one stock's raw connector responses at a moment in
 * time. The eval judge replays them through compute layer + adapter and
 * diffs the result against a locked `expected` file. This is the
 * regression net for the compute layer + market normalisation logic.
 *
 * Two formats, paired by `id`:
 *   fixtures/<id>.json  — raw snapshot (StockSnapshot rawFacts only;
 *                          compute output is intentionally elided so the
 *                          judge can recompute and compare)
 *   expected/<id>.json  — locked computed values (ratios / technical /
 *                          red flags / valuation / availability summary)
 */

import { z } from 'zod';

/** Stable identifier — `${market}_${symbol}_${YYYYMMDD}`. */
export type FixtureId = string;

export const FixtureMetaSchema = z.object({
  id: z.string(),
  symbol: z.string(),
  market: z.enum(['US', 'CN', 'HK']),
  vendoredAt: z.string().datetime(),
  description: z.string(),
  category: z
    .enum([
      'mature_large_cap',
      'fresh_ipo',
      'suspended',
      'loss_making',
      'st',
      'low_liquidity',
      'synthetic',
    ])
    .optional(),
});
export type FixtureMeta = z.infer<typeof FixtureMetaSchema>;

/**
 * Fixture file — snapshot raw facts + metadata. Stored as JSON.
 * The expected/<id>.json file holds the locked outputs.
 *
 * NOTE: we serialize rawFacts as the raw connector return shapes (Quote,
 * FinancialsBundle, PriceBar[], etc.) — these have stable zod schemas in
 * research-core so consumers can deserialize without manual casting.
 */
export interface RawFixture {
  meta: FixtureMeta;
  /** Same shape as StockSnapshot.rawFacts. JSON-serialized. */
  rawFacts: Record<string, unknown>;
  /**
   * Citations vendored from the original connector responses. The judge
   * replays through snapshotToEvidencePack so they end up routed
   * correctly even after compute reruns.
   */
  citations: Array<{
    factKey: string;
    title: string;
    url: string;
    retrievedAt: string;
    asOf?: string;
    provider?: string;
  }>;
  /** Same shape as StockSnapshot.dataAvailability. */
  dataAvailability: {
    available: string[];
    missing: Array<{ field: string; reason: string; detail?: string }>;
    warnings: string[];
  };
}

/**
 * The judge tolerates small float drift on every numeric field — locked
 * values come from a frozen compute pass; later changes to the layer
 * (e.g. revising MACD epsilon, rounding strategy) may shift by < 0.5%
 * without being a regression. Anything larger is reported.
 */
export const NUMERIC_TOLERANCE = 0.005;

/** Subset of ComputedFacts that the judge diffs. */
export interface ExpectedComputedFacts {
  ratios: {
    pe: number | null;
    pb: number | null;
    ps: number | null;
    grossMargin: number | null;
    netMargin: number | null;
    roe: number | null;
    fcfYield: number | null;
  } | null;
  technicalIndicators: {
    sma20: number | null;
    sma50: number | null;
    sma200: number | null;
    rsi14: number | null;
    macdTrend: 'bullish' | 'bearish' | 'neutral' | null;
    trend: 'uptrend' | 'downtrend' | 'sideways';
  } | null;
  redFlagsCount: number;
  redFlagRules: string[];
  valuation: {
    marketCap: number | null;
    impliedGrowthRate: number | null;
    pe5yPercentile: number | null;
  } | null;
  availability: {
    available: string[];
    missingCount: number;
  };
}

export interface ExpectedFixture {
  id: FixtureId;
  /** Hash of the rawFacts JSON — guards against fixture drift. */
  rawHash: string;
  computedFacts: ExpectedComputedFacts;
}

/** Result of one fixture run. */
export interface JudgeRunResult {
  id: FixtureId;
  ok: boolean;
  /** Numeric diffs above tolerance, label diffs, count mismatches. */
  diffs: Array<{
    path: string;
    expected: unknown;
    actual: unknown;
    note?: string;
  }>;
}
