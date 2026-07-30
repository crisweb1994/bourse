/**
 * Compute layer · canonical bundle readers + math primitives.
 *
 * Single source of truth for the helpers that financial-ratios.ts,
 * valuation-helpers.ts and red-flags.ts previously each re-implemented
 * (divergently). Consolidating here keeps one definition of:
 *
 * - `normalizeQuoteMarketCap` — nullable canonical marketCap access
 * - `pickAnchor` — TTM ?? latest-FY period selection
 * - `readLine` — warning-aware line-item → base-unit reader
 * - `computeEnterpriseValue` — pure marketCap + debt − cash
 * - `safeDiv` / `sumNullable` / `subNullable` — null-safe arithmetic
 *
 * Contract notes:
 * - `readLine` is the warning-aware reader. The previous valuation/red-flags
 *   readers (`readLineValue` / `readVal`) silently dropped `unknown_unit`
 *   warnings. The *numeric* result is identical (the `metric` label only
 *   shapes the warning detail text, never the value); standardizing here can
 *   surface a warning those call sites used to swallow, but never changes a
 *   computed number.
 */

import type {
  FinancialsLineItem,
  FinancialsPeriodEntry,
} from '@bourse/market-data';
import type { Quote } from '@bourse/market-data';
import type { ComputeWarning } from './types';
import { normalize } from './units';

// ----------------------------------------------------------------------------
// Quote normalization
// ----------------------------------------------------------------------------

/**
 * Connectors normalize marketCap to instrument-currency base units. Compute
 * code therefore remains provider- and market-agnostic.
 */
export function normalizeQuoteMarketCap(quote: Quote | null): number | null {
  return quote?.marketCap ?? null;
}

// ----------------------------------------------------------------------------
// Period anchoring — prefer TTM, fall back to latest FY
// ----------------------------------------------------------------------------

/**
 * Anchor period selection: the trailing-twelve-months entry when present,
 * otherwise the latest full-year entry. `periods` is ordered latest-first by
 * the financials port, so `find` over `kind` reproduces the historical
 * `pickTtm ?? pickLatestFy` semantics (and the inline
 * `find(kind==='TTM') ?? find(kind==='FY')` valuation used).
 */
export function pickAnchor(
  periods: readonly FinancialsPeriodEntry[],
): FinancialsPeriodEntry | null {
  return (
    periods.find((p) => p.kind === 'TTM') ??
    periods.find((p) => p.kind === 'FY') ??
    null
  );
}

// ----------------------------------------------------------------------------
// Line-item read — extract + normalize to base unit (warning-aware)
// ----------------------------------------------------------------------------

export function readLine(
  item: FinancialsLineItem | undefined,
  metric: string,
  warnings: ComputeWarning[],
): number | null {
  if (!item) return null;
  const { value, warning } = normalize(item.value, item.unit, metric);
  if (warning) warnings.push(warning);
  return value;
}

// ----------------------------------------------------------------------------
// Math helpers — null-safe, division-safe
// ----------------------------------------------------------------------------

export function safeDiv(
  num: number | null,
  den: number | null,
  warnings: ComputeWarning[],
  metric: string,
): number | null {
  if (num === null || den === null) return null;
  if (den === 0) {
    warnings.push({ code: 'division_by_zero', metric, detail: `denominator is 0 for ${metric}` });
    return null;
  }
  return num / den;
}

export function sumNullable(a: number | null, b: number | null): number | null {
  if (a === null && b === null) return null;
  return (a ?? 0) + (b ?? 0);
}

export function subNullable(a: number | null, b: number | null): number | null {
  if (a === null || b === null) return null;
  return a - b;
}

/**
 * Enterprise value — pure form. EV = marketCap + debt − cash, with missing
 * debt / cash treated as 0. Callers resolve the anchor period and read
 * `totalLiabilities` / `cashAndCashEquivalents` themselves (via `readLine`),
 * so this stays a plain 3-arg computation with no bundle walking.
 */
export function computeEnterpriseValue(
  marketCap: number | null,
  totalLiabilities: number | null,
  cash: number | null,
): number | null {
  if (marketCap === null) return null;
  const debt = totalLiabilities ?? 0;
  const ca = cash ?? 0;
  return marketCap + debt - ca;
}
