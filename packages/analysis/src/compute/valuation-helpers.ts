/**
 * Compute layer · valuation helpers.
 *
 * Three families of value:
 *   1. PE historical percentile  — where does the current PE sit in its
 *      own 5-year range? Built from periodTrends EPS × historical close
 *      prices on each period's fiscalYearEnd date.
 *   2. Reverse DCF — what 10-year growth rate is the current market cap
 *      implying? Solve for `g` such that PV(FCF growing at g, then
 *      terminal g_t) = current market cap. Newton-Raphson with
 *      bracketing fallback; bounded growth ∈ [-50%, +50%].
 *   3. Forward DCF (simplified) — what is a fair price given an assumed
 *      growth rate (default 5%, or 0.8 × consensusEpsGrowth when
 *      available)?
 *
 * All numbers are nullable. Missing inputs → null + ComputeWarning, no
 * throws. Currency unit assumed normalized (see compute/units.ts).
 */

import { z } from 'zod';
import type { FinancialsBundle } from '../ports/financials';
import type { PriceBar, Quote } from '../ports/finance';
import type { ComputeWarning } from './types';
import { normalizeCurrency, currencyForMarket } from './units';
import {
  computeEnterpriseValue,
  normalizeQuoteMarketCap,
  pickAnchor,
  readLine,
} from './read-bundle';

// ============================================================================
// Schema
// ============================================================================

export const ComputedValuationSchema = z.object({
  marketCap: z.number().nullable(),
  enterpriseValue: z.number().nullable(),

  // PE historical percentile (built from FY EPS × historical price)
  pe5yHigh: z.number().nullable(),
  pe5yLow: z.number().nullable(),
  pe5yMedian: z.number().nullable(),
  pe5yPercentile: z.number().min(0).max(100).nullable(),
  peHistorySeries: z.array(
    z.object({
      period: z.string(),
      fiscalYearEnd: z.string(),
      eps: z.number(),
      closePrice: z.number(),
      pe: z.number(),
    }),
  ),

  // Reverse DCF — what growth does the market imply?
  impliedGrowthRate: z.number().nullable(),
  impliedGrowthAssumptions: z.object({
    wacc: z.number(),
    terminalGrowth: z.number(),
    forecastYears: z.number().int(),
  }),

  // Forward DCF (simplified)
  fairValuePerShare: z.number().nullable(),
  fairValueAssumedGrowth: z.number().nullable(),
  upside: z.number().nullable(), // (fair - current) / current

  baseCurrency: z.enum(['USD', 'CNY', 'HKD']),
  computedAt: z.string().datetime(),
});
export type ComputedValuation = z.infer<typeof ComputedValuationSchema>;

// ============================================================================
// Public API
// ============================================================================

export interface ComputeValuationInput {
  bundle: FinancialsBundle | null;
  quote: Quote | null;
  history: readonly PriceBar[] | null;
  market: 'US' | 'CN' | 'HK';
  /** Optional consensus EPS growth (e.g. derived from ConsensusEpsBundle). */
  consensusEpsGrowth?: number | null;
  /** Override default DCF assumptions for testing / future config. */
  dcfAssumptions?: {
    wacc?: number;
    terminalGrowth?: number;
    forecastYears?: number;
  };
}

export interface ComputeValuationResult {
  valuation: ComputedValuation | null;
  warnings: ComputeWarning[];
}

const DEFAULT_DCF = {
  wacc: 0.1,
  terminalGrowth: 0.03,
  forecastYears: 10,
};

export function computeValuation(
  input: ComputeValuationInput,
): ComputeValuationResult {
  const warnings: ComputeWarning[] = [];
  const baseCurrency = input.bundle
    ? normalizeCurrency(input.bundle.currency) ?? currencyForMarket(input.market)
    : currencyForMarket(input.market);

  const dcf = {
    wacc: input.dcfAssumptions?.wacc ?? DEFAULT_DCF.wacc,
    terminalGrowth: input.dcfAssumptions?.terminalGrowth ?? DEFAULT_DCF.terminalGrowth,
    forecastYears: input.dcfAssumptions?.forecastYears ?? DEFAULT_DCF.forecastYears,
  };

  // Market cap is the bedrock; without it almost nothing computes.
  const marketCap = normalizeQuoteMarketCap(input.quote, input.market, warnings);

  // ---- Enterprise value -----------------------------------------------------
  // Resolve the same anchor period (TTM ?? latest FY) and read normalized
  // totalLiabilities / cash, then EV = marketCap + debt − cash. Missing debt
  // or cash is treated as 0 by computeEnterpriseValue, matching prior behavior.
  const evAnchor =
    input.bundle && input.bundle.periods.length > 0
      ? pickAnchor(input.bundle.periods)
      : null;
  const ev =
    marketCap === null || !evAnchor
      ? null
      : computeEnterpriseValue(
          marketCap,
          readLine(evAnchor.balance.totalLiabilities, 'totalLiabilities', warnings),
          readLine(evAnchor.balance.cashAndCashEquivalents, 'cash', warnings),
        );

  // ---- PE historical percentile --------------------------------------------
  const peHistory = buildPeHistorySeries(input.bundle, input.history, warnings);
  const peStats = summarizePeHistory(peHistory, currentPe(marketCap, input.bundle, warnings));

  // ---- Reverse DCF: solve for implied growth -------------------------------
  const ttmFcf = ttmFreeCashFlow(input.bundle, warnings);
  const impliedGrowth =
    marketCap !== null && ttmFcf !== null && ttmFcf > 0
      ? solveImpliedGrowth(marketCap, ttmFcf, dcf, warnings)
      : null;

  // ---- Forward DCF: fair value per share -----------------------------------
  const shares = sharesOutstanding(input.quote, marketCap);
  const assumedGrowth = pickAssumedGrowth(input.consensusEpsGrowth);
  const fairValuePerShare =
    ttmFcf !== null && ttmFcf > 0 && shares !== null && shares > 0
      ? forwardDcfFairValue(ttmFcf, shares, dcf, assumedGrowth)
      : null;
  const upside =
    fairValuePerShare !== null && input.quote?.price && input.quote.price > 0
      ? (fairValuePerShare - input.quote.price) / input.quote.price
      : null;

  // Bail entirely when we couldn't compute any single number
  if (
    marketCap === null &&
    ev === null &&
    peStats.percentile === null &&
    impliedGrowth === null &&
    fairValuePerShare === null
  ) {
    return { valuation: null, warnings };
  }

  return {
    valuation: {
      marketCap,
      enterpriseValue: ev,
      pe5yHigh: peStats.high,
      pe5yLow: peStats.low,
      pe5yMedian: peStats.median,
      pe5yPercentile: peStats.percentile,
      peHistorySeries: peHistory,
      impliedGrowthRate: impliedGrowth,
      impliedGrowthAssumptions: dcf,
      fairValuePerShare,
      fairValueAssumedGrowth: fairValuePerShare !== null ? assumedGrowth : null,
      upside,
      baseCurrency,
      computedAt: new Date().toISOString(),
    },
    warnings,
  };
}

// ============================================================================
// PE history
// ============================================================================

interface PeHistoryEntry {
  period: string;
  fiscalYearEnd: string;
  eps: number;
  closePrice: number;
  pe: number;
}

function buildPeHistorySeries(
  bundle: FinancialsBundle | null,
  history: readonly PriceBar[] | null,
  warnings: ComputeWarning[],
): PeHistoryEntry[] {
  if (!bundle || !history || history.length === 0) {
    if (bundle && (!history || history.length === 0)) {
      warnings.push({
        code: 'insufficient_history',
        metric: 'pe5yPercentile',
        detail: 'price history not provided — cannot map EPS to historical prices',
      });
    }
    return [];
  }

  const fys = bundle.periods.filter((p) => p.kind === 'FY');
  const out: PeHistoryEntry[] = [];
  for (const p of fys) {
    const eps = readLine(p.income.eps, 'eps', warnings);
    if (eps === null || eps <= 0) continue;
    const close = priceOnOrBefore(history, p.fiscalYearEnd);
    if (close === null) continue;
    const pe = close / eps;
    if (!Number.isFinite(pe) || pe <= 0) continue;
    out.push({
      period: p.fiscalPeriod,
      fiscalYearEnd: p.fiscalYearEnd,
      eps,
      closePrice: close,
      pe,
    });
  }
  return out;
}

function priceOnOrBefore(
  history: readonly PriceBar[],
  isoDate: string,
): number | null {
  // History is ascending; find the latest bar whose timestamp <= isoDate.
  let result: number | null = null;
  for (const bar of history) {
    const ts = bar.timestamp.slice(0, 10);
    if (ts <= isoDate) {
      result = bar.adjustedClose ?? bar.close;
    } else {
      break;
    }
  }
  return result;
}

interface PeStats {
  high: number | null;
  low: number | null;
  median: number | null;
  percentile: number | null;
}

function summarizePeHistory(
  series: PeHistoryEntry[],
  currentPeVal: number | null,
): PeStats {
  if (series.length === 0) {
    return { high: null, low: null, median: null, percentile: null };
  }
  const values = series.map((e) => e.pe).sort((a, b) => a - b);
  const high = values[values.length - 1]!;
  const low = values[0]!;
  const median =
    values.length % 2 === 1
      ? values[(values.length - 1) / 2]!
      : (values[values.length / 2 - 1]! + values[values.length / 2]!) / 2;

  if (currentPeVal === null) {
    return { high, low, median, percentile: null };
  }
  // Percentile rank (0-100): % of historical PE values strictly below current.
  let belowCount = 0;
  for (const v of values) if (v < currentPeVal) belowCount++;
  const percentile = (belowCount / values.length) * 100;
  return { high, low, median, percentile };
}

function currentPe(
  marketCap: number | null,
  bundle: FinancialsBundle | null,
  warnings: ComputeWarning[],
): number | null {
  if (marketCap === null || !bundle || bundle.periods.length === 0) return null;
  // Prefer TTM, fallback to latest FY
  const anchor = pickAnchor(bundle.periods);
  if (!anchor) return null;
  const ni = readLine(anchor.income.netIncome, 'netIncome', warnings);
  if (ni === null || ni === 0) return null;
  return marketCap / ni;
}

// ============================================================================
// Reverse DCF (solve for implied growth)
// ============================================================================

/**
 * Find growth rate `g` such that PV( forecast FCF | g ) ≈ marketCap.
 *
 * Model:
 *   year t ∈ [1, forecastYears]: FCF_t = FCF_0 * (1+g)^t
 *   PV_forecast = Σ FCF_t / (1+wacc)^t
 *   Terminal value at T = FCF_T * (1+g_t) / (wacc - g_t)
 *   PV_terminal = TV / (1+wacc)^T
 *   PV = PV_forecast + PV_terminal
 *
 * Search bracket: g ∈ [-0.5, +0.5]. PV is monotonically increasing in g
 * within the bracket (provided wacc > g_t), so bisection converges.
 */
function solveImpliedGrowth(
  marketCap: number,
  ttmFcf: number,
  dcf: { wacc: number; terminalGrowth: number; forecastYears: number },
  warnings: ComputeWarning[],
): number | null {
  const { wacc, terminalGrowth, forecastYears } = dcf;
  if (wacc <= terminalGrowth) {
    warnings.push({
      code: 'missing_data',
      metric: 'impliedGrowthRate',
      detail: 'WACC must exceed terminal growth for DCF to converge',
    });
    return null;
  }

  const pv = (g: number) => dcfPresentValue(ttmFcf, g, wacc, terminalGrowth, forecastYears);

  // Bisection: target PV = marketCap
  let lo = -0.5;
  let hi = 0.5;
  let pvLo = pv(lo);
  let pvHi = pv(hi);

  // Edge: market cap outside what model can express even at bounds
  if (marketCap <= pvLo) return -0.5;
  if (marketCap >= pvHi) return 0.5;

  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    const pvMid = pv(mid);
    if (Math.abs(pvMid - marketCap) / marketCap < 1e-6) return mid;
    if (pvMid < marketCap) {
      lo = mid;
      pvLo = pvMid;
    } else {
      hi = mid;
      pvHi = pvMid;
    }
  }
  return (lo + hi) / 2;
}

function dcfPresentValue(
  fcf0: number,
  g: number,
  wacc: number,
  terminalG: number,
  years: number,
): number {
  let pv = 0;
  let fcf = fcf0;
  for (let t = 1; t <= years; t++) {
    fcf = fcf * (1 + g);
    pv += fcf / Math.pow(1 + wacc, t);
  }
  const tv = (fcf * (1 + terminalG)) / (wacc - terminalG);
  pv += tv / Math.pow(1 + wacc, years);
  return pv;
}

// ============================================================================
// Forward DCF (fair value)
// ============================================================================

function forwardDcfFairValue(
  ttmFcf: number,
  shares: number,
  dcf: { wacc: number; terminalGrowth: number; forecastYears: number },
  assumedGrowth: number,
): number {
  const totalPv = dcfPresentValue(ttmFcf, assumedGrowth, dcf.wacc, dcf.terminalGrowth, dcf.forecastYears);
  return totalPv / shares;
}

function pickAssumedGrowth(consensusEpsGrowth: number | null | undefined): number {
  // If we have a consensus growth signal, haircut by 20% (analyst optimism).
  // Otherwise default to 5% — broadly representative of mature-cap growth.
  if (consensusEpsGrowth !== null && consensusEpsGrowth !== undefined) {
    return consensusEpsGrowth * 0.8;
  }
  return 0.05;
}

// ============================================================================
// Helpers
// ============================================================================

function ttmFreeCashFlow(
  bundle: FinancialsBundle | null,
  warnings: ComputeWarning[],
): number | null {
  if (!bundle || bundle.periods.length === 0) return null;
  const anchor = pickAnchor(bundle.periods);
  if (!anchor) return null;
  const fcf = readLine(anchor.cashFlow.freeCashFlow, 'freeCashFlow', warnings);
  if (fcf === null) {
    warnings.push({
      code: 'missing_data',
      metric: 'ttmFreeCashFlow',
      detail: 'free cash flow missing on anchor period — DCF metrics will be null',
    });
  }
  return fcf;
}

function sharesOutstanding(quote: Quote | null, marketCap: number | null): number | null {
  if (!quote || quote.price === undefined || quote.price <= 0) return null;
  if (marketCap === null) return null;
  return marketCap / quote.price;
}

// Internal exports for unit tests (so we can exercise the DCF solver in
// isolation without needing the full FinancialsBundle scaffolding).
export const __test = {
  dcfPresentValue,
  solveImpliedGrowth,
  pickAssumedGrowth,
  buildPeHistorySeries,
  summarizePeHistory,
  priceOnOrBefore,
};
