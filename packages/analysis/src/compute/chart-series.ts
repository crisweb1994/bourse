/**
 * Compute layer · chart series derivation.
 *
 * Deterministic, chart-facing derivations from PriceBar[]:
 *  - `derivePriceSeries` builds the adjusted-basis OHLCV block persisted in
 *    EvidencePackV2.priceSeries (visualization technical design §四.①).
 *  - `smaPoints` builds self-describing `{t, v}` moving-average point series
 *    keyed by bar date (§四.②) — alignment is structural, not index-based.
 *
 * Contracts (tested as I1–I7 in chart-series.test.ts):
 *  - I1  derived close ≡ source adjustedClose (verbatim, never recomputed)
 *  - I2  multiplying one bar's o/h/l by the same positive factor preserves
 *        ordering: h' ≥ max(o', c') and l' ≤ min(o', c')
 *  - I3  non-finite / non-positive factors fall back to factor=1 and are
 *        surfaced via the `basis` enum ('raw' / 'derived' / 'mixed'); never
 *        throw
 *  - I4  SMA input closes are the SAME array basis as the derived bars' `c`
 *        (adjustedClose ?? close) — one function owns the basis
 *  - I5  every point's `t` exists in the source bar dates
 *  - I6  point dates are strictly ascending (bars are ascending)
 *  - I7  the first sma{w} point's date === bars[w-1].t (converged window)
 *
 * The basis decision (F16 reality): free CN/HK sources do not return
 * adjustedClose, so `basis` honestly reports 'raw' there instead of pretending
 * adjustment happened. No downsampling here — max supported window (1095d ≈
 * 756 bars) stays under MAX_BARS (R15 bans sampling-style downsampling).
 */

import { z } from 'zod';
import type { PriceBar } from '@bourse/market-data';
import type { SourceTier } from '../contracts/evidence-pack-v2';

// ============================================================================
// Schemas
// ============================================================================

/** Self-describing point for moving-average series (t = bar date). */
export const ChartPricePointSchema = z.object({
  t: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  v: z.number().finite(),
});
export type ChartPricePoint = z.infer<typeof ChartPricePointSchema>;

export const PriceSeriesBarSchema = z.object({
  t: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  o: z.number().finite(),
  h: z.number().finite(),
  l: z.number().finite(),
  c: z.number().finite(),
  v: z.number().nullable(),
});
export type PriceSeriesBar = z.infer<typeof PriceSeriesBarSchema>;

/**
 * Which price basis the bars are on:
 *  - raw     — no source bar carried adjustedClose
 *  - derived — every bar carried adjustedClose; o/h/l were scaled by the
 *              per-bar factor so candles and adjustedClose-based indicators
 *              share one basis
 *  - mixed   — some bars carried adjustedClose, some did not (chart should
 *              surface a basis-mixing caveat)
 */
export const PriceSeriesBasis = z.enum(['raw', 'derived', 'mixed']);
export type PriceSeriesBasis = z.infer<typeof PriceSeriesBasis>;

export const PriceSeriesBlockSchema = z.object({
  bars: z.array(PriceSeriesBarSchema).max(1200),
  basis: PriceSeriesBasis,
  /** 52-week extremes from the derived (basis-consistent) series; null when
   *  fewer than 200 bars are available (cannot honestly claim "52-week"). */
  week52High: z.number().nullable(),
  week52Low: z.number().nullable(),
  asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  sourceTier: z.enum(['A', 'B', 'C', 'D', 'E']),
});
export type PriceSeriesBlock = z.infer<typeof PriceSeriesBlockSchema>;

export const MAX_PRICE_SERIES_BARS = 1200;

/** Bars below this count cannot support a "52-week" label. */
export const MIN_BARS_FOR_WEEK52 = 200;

// ============================================================================
// Derivation
// ============================================================================

function barDate(bar: PriceBar): string | null {
  const raw = bar.timestamp;
  if (typeof raw !== 'string' || raw.length < 10) return null;
  const date = raw.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null;
}

/**
 * Build the chart-facing price series from connector bars.
 * Returns null when there are no usable bars (fetch failed / empty).
 */
export function derivePriceSeries(
  bars: readonly PriceBar[],
  sourceTier: SourceTier,
): PriceSeriesBlock | null {
  const usable: PriceSeriesBar[] = [];
  let barsWithAdjusted = 0;

  for (const bar of bars) {
    const t = barDate(bar);
    if (!t) continue;
    const close = Number(bar.close);
    if (!Number.isFinite(close) || close <= 0) continue;

    const adjusted = Number(bar.adjustedClose);
    const hasAdjusted =
      bar.adjustedClose !== undefined && bar.adjustedClose !== null &&
      Number.isFinite(adjusted) && adjusted > 0;
    // I3: non-finite / non-positive factor → treat as "no adjustment", f=1.
    const factor = hasAdjusted ? adjusted / close : 1;
    if (!Number.isFinite(factor) || factor <= 0) continue;

    const o = Number(bar.open);
    const h = Number(bar.high);
    const l = Number(bar.low);
    const scale = (x: number): number => (Number.isFinite(x) ? x * factor : close);
    // I1: c' is the source adjustedClose verbatim; I2: single positive
    // factor preserves high/low ordering by construction.
    usable.push({
      t,
      o: scale(o),
      h: Math.max(scale(h), scale(o), adjusted > 0 ? adjusted : close),
      l: Math.min(scale(l), scale(o), adjusted > 0 ? adjusted : close),
      c: hasAdjusted ? adjusted : close,
      v: bar.volume != null && Number.isFinite(Number(bar.volume)) ? Number(bar.volume) : null,
    });
    if (hasAdjusted) barsWithAdjusted++;
  }

  if (usable.length === 0) return null;

  const basis: PriceSeriesBasis =
    barsWithAdjusted === 0
      ? 'raw'
      : barsWithAdjusted === usable.length
        ? 'derived'
        : 'mixed';

  // Keep only the newest MAX_PRICE_SERIES_BARS bars (no resampling — R15).
  const clipped = usable.length > MAX_PRICE_SERIES_BARS
    ? usable.slice(usable.length - MAX_PRICE_SERIES_BARS)
    : usable;

  let week52High: number | null = null;
  let week52Low: number | null = null;
  if (clipped.length >= MIN_BARS_FOR_WEEK52) {
    week52High = Math.max(...clipped.map((b) => b.h));
    week52Low = Math.min(...clipped.map((b) => b.l));
  }

  return {
    bars: clipped,
    basis,
    week52High,
    week52Low,
    asOf: clipped[clipped.length - 1]!.t,
    sourceTier,
  };
}

/**
 * Rolling SMA as `{t, v}` points over the indicator basis closes
 * (adjustedClose ?? close — the same array `computeTechnicalIndicators`
 * uses, I4). Only converged points are emitted: the first point's date is
 * bars[window-1].t (I7), dates ascending (I6), all keys exist in bars (I5).
 */
export function smaPoints(
  bars: readonly PriceBar[],
  window: number,
): ChartPricePoint[] {
  if (bars.length < window || window <= 0) return [];
  const points: ChartPricePoint[] = [];
  let sum = 0;
  for (let i = 0; i < bars.length; i++) {
    const close = bars[i]!.adjustedClose ?? bars[i]!.close;
    sum += close;
    if (i >= window) sum -= bars[i - window]!.adjustedClose ?? bars[i - window]!.close;
    if (i >= window - 1) {
      const t = barDate(bars[i]!);
      if (t) points.push({ t, v: sum / window });
    }
  }
  return points;
}
