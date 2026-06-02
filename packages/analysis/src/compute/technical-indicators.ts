/**
 * Compute layer · technical indicators.
 *
 * Input:  PriceBar[] from finance connector (Yahoo v8/chart / tencent /
 *         akshare). Expects daily bars, latest LAST.
 * Output: ComputedTechnicalIndicators — SMA/EMA/RSI/MACD/Bollinger/ATR/OBV +
 *         derived trend / momentum labels.
 *
 * Contracts:
 * - All series indicators degrade to `null` when input bars are insufficient.
 *   E.g. SMA200 requires ≥200 bars; RSI14 requires ≥15 bars.
 * - We use **closing prices** (or `adjustedClose` when present) for all
 *   trend / momentum / volatility math. OHLC is only used for ATR and
 *   support / resistance.
 * - Suspension days (gaps in the bar series) are NOT back-filled — we trust
 *   the connector to omit them. Indicators that span > 1y of data therefore
 *   reflect *trading-day* windows, which is the convention.
 * - Latest bar position: caller must pass bars in ascending time order
 *   (oldest → newest). We assert via timestamp monotonicity on the first
 *   call and return null + warning when violated.
 */

import { z } from 'zod';
import type { PriceBar } from '../ports/finance';
import type { ComputeWarning } from './types';

// ============================================================================
// Schema
// ============================================================================

export const ComputedTechnicalIndicatorsSchema = z.object({
  asOf: z.string().datetime(),
  bars: z.number().int().nonnegative(),
  lastClose: z.number().nullable(),

  // Trend
  sma20: z.number().nullable(),
  sma50: z.number().nullable(),
  sma200: z.number().nullable(),
  currentVsSma200: z.enum(['above', 'below']).nullable(),

  // Momentum
  rsi14: z.number().nullable(),
  macdLine: z.number().nullable(),
  macdSignal: z.number().nullable(),
  macdHistogram: z.number().nullable(),
  macdTrend: z.enum(['bullish', 'bearish', 'neutral']).nullable(),

  // Volatility
  atr14: z.number().nullable(),
  bollingerUpper: z.number().nullable(),
  bollingerMiddle: z.number().nullable(),
  bollingerLower: z.number().nullable(),
  bollingerPosition: z
    .enum(['above_upper', 'upper_half', 'lower_half', 'below_lower'])
    .nullable(),

  // Support / resistance (last 6 months swing high/low)
  nearestSupport: z.number().nullable(),
  nearestResistance: z.number().nullable(),

  // Volume
  volumeVs20dAvg: z.number().nullable(),
  obvTrend: z.enum(['rising', 'falling', 'flat']).nullable(),

  // Composite labels (the only "judgement" indicators)
  trend: z.enum(['uptrend', 'downtrend', 'sideways']),
  momentum: z.enum(['overbought', 'oversold', 'neutral']),
});
export type ComputedTechnicalIndicators = z.infer<
  typeof ComputedTechnicalIndicatorsSchema
>;

// ============================================================================
// Public API
// ============================================================================

export interface ComputeTechnicalInput {
  bars: readonly PriceBar[];
}

export interface ComputeTechnicalResult {
  indicators: ComputedTechnicalIndicators | null;
  warnings: ComputeWarning[];
}

export function computeTechnicalIndicators(
  input: ComputeTechnicalInput,
): ComputeTechnicalResult {
  const warnings: ComputeWarning[] = [];
  const bars = input.bars;

  if (bars.length === 0) {
    return { indicators: null, warnings };
  }

  if (!isAscending(bars)) {
    warnings.push({
      code: 'missing_data',
      metric: 'priceBars',
      detail: 'PriceBars must be in ascending time order',
    });
    return { indicators: null, warnings };
  }

  const closes = bars.map((b) => b.adjustedClose ?? b.close);
  const lastClose = closes[closes.length - 1] ?? null;

  // SMAs
  const sma20 = sma(closes, 20);
  const sma50 = sma(closes, 50);
  const sma200 = sma(closes, 200);
  if (sma200 === null) {
    warnings.push({
      code: 'insufficient_history',
      metric: 'sma200',
      detail: `Need ≥200 bars for SMA200, have ${bars.length}`,
    });
  }
  const currentVsSma200 =
    sma200 !== null && lastClose !== null
      ? lastClose > sma200
        ? ('above' as const)
        : ('below' as const)
      : null;

  // RSI
  const rsi14 = rsi(closes, 14);

  // MACD (12/26/9)
  const macd = computeMacd(closes, 12, 26, 9);
  const macdTrend = labelMacdTrend(macd.line, macd.signal, macd.histogram);

  // Bollinger 20 ± 2σ
  const boll = bollinger(closes, 20, 2);
  const bollPos =
    boll && lastClose !== null
      ? labelBollingerPosition(lastClose, boll.upper, boll.middle, boll.lower)
      : null;

  // ATR
  const atr14 = atr(bars, 14);

  // Support / resistance — last 126 bars (~6 months trading days)
  const sr = supportResistance(bars, 126, lastClose);

  // Volume relative
  const volumeVs20dAvg = volumeRatio(bars, 20);
  const obvTrendLabel = obvTrend(bars, 20);

  // Composite
  const trendLabel = labelTrend(lastClose, sma20, sma50, sma200);
  const momentumLabel = labelMomentum(rsi14);

  const indicators: ComputedTechnicalIndicators = {
    // Connectors often emit date-only (`YYYY-MM-DD`) for daily bars; the
    // schema requires full ISO datetime. Coerce `YYYY-MM-DD` → midnight
    // UTC ISO. Existing full-ISO timestamps pass through unchanged.
    asOf: normalizeBarTimestamp(bars[bars.length - 1]!.timestamp),
    bars: bars.length,
    lastClose,
    sma20,
    sma50,
    sma200,
    currentVsSma200,
    rsi14,
    macdLine: macd.line,
    macdSignal: macd.signal,
    macdHistogram: macd.histogram,
    macdTrend,
    atr14,
    bollingerUpper: boll?.upper ?? null,
    bollingerMiddle: boll?.middle ?? null,
    bollingerLower: boll?.lower ?? null,
    bollingerPosition: bollPos,
    nearestSupport: sr.support,
    nearestResistance: sr.resistance,
    volumeVs20dAvg,
    obvTrend: obvTrendLabel,
    trend: trendLabel,
    momentum: momentumLabel,
  };

  return { indicators, warnings };
}

// ============================================================================
// Indicator primitives
// ============================================================================

function sma(values: readonly number[], window: number): number | null {
  if (values.length < window) return null;
  let sum = 0;
  for (let i = values.length - window; i < values.length; i++) sum += values[i]!;
  return sum / window;
}

/**
 * Exponential moving average. Seed = SMA of first `window` values, then
 * EMA = α × close + (1 − α) × prevEma where α = 2 / (window + 1).
 * Returns the EMA series of equal length as input (NaN-padded prefix is
 * dropped — the array starts at index `window-1` of the input).
 */
function emaSeries(values: readonly number[], window: number): number[] {
  if (values.length < window) return [];
  const alpha = 2 / (window + 1);
  const out: number[] = [];
  // Seed with SMA
  let acc = 0;
  for (let i = 0; i < window; i++) acc += values[i]!;
  let prev = acc / window;
  out.push(prev);
  for (let i = window; i < values.length; i++) {
    prev = alpha * values[i]! + (1 - alpha) * prev;
    out.push(prev);
  }
  return out;
}

/**
 * Wilder-style RSI. Uses smoothed averages (not simple averages) — matches
 * TradingView default.
 */
function rsi(values: readonly number[], window: number): number | null {
  if (values.length < window + 1) return null;
  let gainSum = 0;
  let lossSum = 0;
  for (let i = 1; i <= window; i++) {
    const delta = values[i]! - values[i - 1]!;
    if (delta > 0) gainSum += delta;
    else lossSum += -delta;
  }
  let avgGain = gainSum / window;
  let avgLoss = lossSum / window;
  for (let i = window + 1; i < values.length; i++) {
    const delta = values[i]! - values[i - 1]!;
    const gain = delta > 0 ? delta : 0;
    const loss = delta < 0 ? -delta : 0;
    avgGain = (avgGain * (window - 1) + gain) / window;
    avgLoss = (avgLoss * (window - 1) + loss) / window;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

interface MacdReadout {
  line: number | null;
  signal: number | null;
  histogram: number | null;
}

function computeMacd(
  values: readonly number[],
  fast: number,
  slow: number,
  signalPeriod: number,
): MacdReadout {
  if (values.length < slow + signalPeriod) {
    return { line: null, signal: null, histogram: null };
  }
  const emaFast = emaSeries(values, fast);
  const emaSlow = emaSeries(values, slow);
  // Align tails (both arrays end at the same data index = values.length - 1)
  const macdLineSeries: number[] = [];
  const offset = emaFast.length - emaSlow.length;
  for (let i = 0; i < emaSlow.length; i++) {
    macdLineSeries.push(emaFast[i + offset]! - emaSlow[i]!);
  }
  const signalSeries = emaSeries(macdLineSeries, signalPeriod);
  const lastLine = macdLineSeries[macdLineSeries.length - 1] ?? null;
  const lastSignal = signalSeries[signalSeries.length - 1] ?? null;
  if (lastLine === null || lastSignal === null) {
    return { line: lastLine, signal: lastSignal, histogram: null };
  }
  return {
    line: lastLine,
    signal: lastSignal,
    histogram: lastLine - lastSignal,
  };
}

function labelMacdTrend(
  line: number | null,
  signal: number | null,
  hist: number | null,
): 'bullish' | 'bearish' | 'neutral' | null {
  if (line === null || signal === null || hist === null) return null;
  // Tolerate float noise — for steady-state series (post-convergence on a
  // pure linear trend) line/signal converge and histogram drops to ~1e-15.
  // Anything below 0.1% of |line| is not a real cross.
  const eps = Math.max(1e-10, Math.abs(line) * 0.001);
  if (hist > eps) return 'bullish';
  if (hist < -eps) return 'bearish';
  return 'neutral';
}

interface BollingerReadout {
  upper: number;
  middle: number;
  lower: number;
}

function bollinger(
  values: readonly number[],
  window: number,
  stdMult: number,
): BollingerReadout | null {
  if (values.length < window) return null;
  const slice = values.slice(values.length - window);
  const mean = slice.reduce((a, b) => a + b, 0) / window;
  const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / window;
  const sd = Math.sqrt(variance);
  return {
    upper: mean + stdMult * sd,
    middle: mean,
    lower: mean - stdMult * sd,
  };
}

function labelBollingerPosition(
  close: number,
  upper: number,
  middle: number,
  lower: number,
): 'above_upper' | 'upper_half' | 'lower_half' | 'below_lower' {
  if (close > upper) return 'above_upper';
  if (close < lower) return 'below_lower';
  if (close > middle) return 'upper_half';
  return 'lower_half';
}

function atr(bars: readonly PriceBar[], window: number): number | null {
  if (bars.length < window + 1) return null;
  const trs: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const cur = bars[i]!;
    const prev = bars[i - 1]!;
    const tr = Math.max(
      cur.high - cur.low,
      Math.abs(cur.high - prev.close),
      Math.abs(cur.low - prev.close),
    );
    trs.push(tr);
  }
  // Wilder smoothing seeded with simple mean of first `window` TRs
  let avg = trs.slice(0, window).reduce((a, b) => a + b, 0) / window;
  for (let i = window; i < trs.length; i++) {
    avg = (avg * (window - 1) + trs[i]!) / window;
  }
  return avg;
}

function supportResistance(
  bars: readonly PriceBar[],
  window: number,
  lastClose: number | null,
): { support: number | null; resistance: number | null } {
  if (bars.length < 5 || lastClose === null) {
    return { support: null, resistance: null };
  }
  const slice = bars.slice(-Math.min(window, bars.length));
  let support: number | null = null;
  let resistance: number | null = null;
  for (const bar of slice) {
    if (bar.low < lastClose) {
      if (support === null || bar.low > support) support = bar.low;
    }
    if (bar.high > lastClose) {
      if (resistance === null || bar.high < resistance) resistance = bar.high;
    }
  }
  return { support, resistance };
}

function volumeRatio(bars: readonly PriceBar[], window: number): number | null {
  if (bars.length < window + 1) return null;
  const lastVol = bars[bars.length - 1]!.volume;
  if (lastVol === undefined) return null;
  let sum = 0;
  let n = 0;
  for (let i = bars.length - window - 1; i < bars.length - 1; i++) {
    const v = bars[i]!.volume;
    if (v !== undefined) {
      sum += v;
      n++;
    }
  }
  if (n === 0) return null;
  const avg = sum / n;
  if (avg === 0) return null;
  return lastVol / avg;
}

function obvTrend(
  bars: readonly PriceBar[],
  lookback: number,
): 'rising' | 'falling' | 'flat' | null {
  if (bars.length < lookback + 1) return null;
  // Compute OBV series
  const obv: number[] = [0];
  for (let i = 1; i < bars.length; i++) {
    const cur = bars[i]!;
    const prev = bars[i - 1]!;
    const v = cur.volume ?? 0;
    const closeCur = cur.adjustedClose ?? cur.close;
    const closePrev = prev.adjustedClose ?? prev.close;
    const last = obv[obv.length - 1]!;
    if (closeCur > closePrev) obv.push(last + v);
    else if (closeCur < closePrev) obv.push(last - v);
    else obv.push(last);
  }
  const cur = obv[obv.length - 1]!;
  const past = obv[obv.length - 1 - lookback]!;
  if (past === 0) return 'flat';
  const ratio = (cur - past) / Math.abs(past);
  if (ratio > 0.05) return 'rising';
  if (ratio < -0.05) return 'falling';
  return 'flat';
}

function labelTrend(
  close: number | null,
  s20: number | null,
  s50: number | null,
  s200: number | null,
): 'uptrend' | 'downtrend' | 'sideways' {
  // Need at least sma50; default to sideways when insufficient
  if (close === null || s50 === null) return 'sideways';
  // Strong uptrend: close > sma20 > sma50 > sma200 (when available)
  if (s200 !== null) {
    if (close > s50 && s50 > s200) return 'uptrend';
    if (close < s50 && s50 < s200) return 'downtrend';
    return 'sideways';
  }
  // Fallback with only sma50
  if (close > s50 * 1.02) return 'uptrend';
  if (close < s50 * 0.98) return 'downtrend';
  return 'sideways';
}

function labelMomentum(
  rsiVal: number | null,
): 'overbought' | 'oversold' | 'neutral' {
  if (rsiVal === null) return 'neutral';
  if (rsiVal > 70) return 'overbought';
  if (rsiVal < 30) return 'oversold';
  return 'neutral';
}

// ============================================================================
// Validation
// ============================================================================

function isAscending(bars: readonly PriceBar[]): boolean {
  for (let i = 1; i < bars.length; i++) {
    if (bars[i]!.timestamp < bars[i - 1]!.timestamp) return false;
  }
  return true;
}

/**
 * Coerce a PriceBar timestamp to a full ISO 8601 datetime string.
 *  - `YYYY-MM-DD` → `YYYY-MM-DDT00:00:00.000Z`
 *  - already-full ISO → returned unchanged
 *  - unparseable → fall back to `new Date().toISOString()` (we still need
 *    a valid datetime for the schema; the warning, if any, has already
 *    been emitted by the caller).
 */
function normalizeBarTimestamp(raw: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return `${raw}T00:00:00.000Z`;
  }
  // Quick sanity: full ISO datetime regex (no exhaustive parse — zod
  // does the strict check downstream)
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(raw)) {
    return raw;
  }
  const parsed = new Date(raw);
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  return new Date().toISOString();
}
