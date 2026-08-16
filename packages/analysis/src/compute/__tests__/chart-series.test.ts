import { describe, expect, it } from 'vitest';
import type { PriceBar } from '@bourse/market-data';
import {
  derivePriceSeries,
  smaPoints,
  MAX_PRICE_SERIES_BARS,
  MIN_BARS_FOR_WEEK52,
} from '../chart-series';
import { computeTechnicalIndicators } from '../technical-indicators';

/** Deterministic bar factory: adjustedClose = close × factor by default. */
function bar(
  i: number,
  opts: {
    close?: number;
    adjusted?: number;
    factor?: number;
    raw?: boolean;
    volume?: number;
  } = {},
): PriceBar {
  const close = opts.close ?? 100 + (i % 7);
  const adjusted = opts.raw
    ? undefined
    : opts.adjusted !== undefined
      ? opts.adjusted
      : (opts.factor ?? 1) * close;
  const open = close - 1;
  const high = close + 2;
  const low = close - 2;
  const d = new Date(Date.UTC(2025, 0, 1) + i * 86_400_000)
    .toISOString()
    .slice(0, 10);
  return {
    timestamp: d,
    open,
    high,
    low,
    close,
    ...(adjusted !== undefined ? { adjustedClose: adjusted } : {}),
    ...(opts.volume !== undefined ? { volume: opts.volume } : {}),
  };
}

describe('derivePriceSeries — basis derivation invariants (I1–I4)', () => {
  it('I1: derived close ≡ source adjustedClose verbatim', () => {
    const bars = [bar(0, { factor: 0.5 }), bar(1, { factor: 0.8 }), bar(2, { factor: 1 })];
    const ps = derivePriceSeries(bars, 'B');
    expect(ps).not.toBeNull();
    bars.forEach((b, i) => {
      expect(ps!.bars[i]!.c).toBe(b.adjustedClose);
    });
  });

  it('I2: single positive factor preserves per-bar ordering (h ≥ max(o,c), l ≤ min(o,c))', () => {
    const bars = Array.from({ length: 30 }, (_, i) => bar(i, { factor: 0.3 + (i % 5) * 0.2 }));
    const ps = derivePriceSeries(bars, 'B')!;
    for (const b of ps.bars) {
      expect(b.h).toBeGreaterThanOrEqual(Math.max(b.o, b.c));
      expect(b.l).toBeLessThanOrEqual(Math.min(b.o, b.c));
    }
  });

  it('I3: non-finite / non-positive adjusted falls back gracefully (basis honest, no throw)', () => {
    const bars = [
      bar(0, { adjusted: Number.NaN }),
      bar(1, { adjusted: -5 }),
      bar(2, { factor: 1 }), // valid adjustedClose
    ];
    const ps = derivePriceSeries(bars, 'B')!;
    expect(ps.basis).toBe('mixed'); // only bar 2 carried a usable adjustedClose
    expect(ps.bars[0]!.c).toBe(bars[0]!.close); // fell back to raw close
  });

  it('basis = raw when no bar carries adjustedClose (CN free-source reality, F16)', () => {
    const bars = [bar(0, { raw: true }), bar(1, { raw: true })];
    expect(derivePriceSeries(bars, 'B')!.basis).toBe('raw');
  });

  it('basis = derived when every bar carries adjustedClose', () => {
    const bars = [bar(0, { factor: 0.5 }), bar(1, { factor: 0.9 })];
    expect(derivePriceSeries(bars, 'A')!.basis).toBe('derived');
  });

  it('returns null for zero usable bars; skips non-positive closes', () => {
    expect(derivePriceSeries([], 'B')).toBeNull();
    const bad: PriceBar[] = [
      { timestamp: '2025-01-01', open: 1, high: 1, low: 1, close: -5 },
    ];
    expect(derivePriceSeries(bad, 'B')).toBeNull();
  });

  it('week52 extremes only when bars ≥ MIN_BARS_FOR_WEEK52, else null', () => {
    const short = derivePriceSeries(Array.from({ length: 30 }, (_, i) => bar(i)), 'B')!;
    expect(short.week52High).toBeNull();
    expect(short.week52Low).toBeNull();
    const long = derivePriceSeries(
      Array.from({ length: MIN_BARS_FOR_WEEK52 + 5 }, (_, i) => bar(i, { close: 100 + i })),
      'B',
    )!;
    expect(long.week52High).toBeGreaterThan(long.week52Low!);
    // week52 on the SAME basis: with factor=1 the extremes equal raw highs/lows
    expect(long.week52High!).toBeCloseTo(100 + MIN_BARS_FOR_WEEK52 + 5 - 1 + 2, 5);
  });

  it(`clips to newest ${MAX_PRICE_SERIES_BARS} bars without resampling`, () => {
    const bars = Array.from({ length: MAX_PRICE_SERIES_BARS + 50 }, (_, i) => bar(i));
    const ps = derivePriceSeries(bars, 'B')!;
    expect(ps.bars).toHaveLength(MAX_PRICE_SERIES_BARS);
    expect(ps.asOf).toBe(ps.bars[MAX_PRICE_SERIES_BARS - 1]!.t);
  });

  it('volume absent passes through as null (P3: no synthesized values)', () => {
    const ps = derivePriceSeries([bar(0, { volume: undefined })], 'B')!;
    expect(ps.bars[0]!.v).toBeNull();
  });
});

describe('smaPoints — {t,v} alignment invariants (I5–I7)', () => {
  const bars = Array.from({ length: 60 }, (_, i) => bar(i, { close: 100 + i }));

  it('I5: every point t exists in bar dates', () => {
    const dates = new Set(bars.map((b) => b.timestamp.slice(0, 10)));
    for (const p of smaPoints(bars, 20)) expect(dates.has(p.t)).toBe(true);
  });

  it('I6: strictly ascending dates', () => {
    const pts = smaPoints(bars, 20);
    for (let i = 1; i < pts.length; i++) expect(pts[i]!.t > pts[i - 1]!.t).toBe(true);
  });

  it('I7: first sma20 point date === bars[19].t, length === bars-19', () => {
    const pts = smaPoints(bars, 20);
    expect(pts[0]!.t).toBe(bars[19]!.timestamp.slice(0, 10));
    expect(pts).toHaveLength(bars.length - 19);
  });

  it('I4: smaPoints input basis matches scalar indicators (adjustedClose ?? close)', () => {
    // Splits on bars 0..29: adjustedClose is half of close.
    const mixed = Array.from({ length: 40 }, (_, i) =>
      i < 30 ? bar(i, { factor: 0.5 }) : bar(i, { factor: 1 }),
    );
    const result = computeTechnicalIndicators({ bars: mixed });
    expect(result.indicators).not.toBeNull();
    const pts = smaPoints(mixed, 20);
    // last sma20 point value must equal the scalar sma20 (same closes array)
    expect(pts[pts.length - 1]!.v).toBeCloseTo(result.indicators!.sma20!, 9);
    // series attached to indicators must match smaPoints output
    expect(result.indicators!.series!.sma20).toEqual(pts);
  });

  it('empty output when bars < window', () => {
    expect(smaPoints(bars.slice(0, 10), 20)).toEqual([]);
  });

  it('uses raw close when adjustedClose is zero and keeps support/resistance on the same basis', () => {
    const rawBars = Array.from({ length: 20 }, (_, i) => bar(i, { close: 100, raw: true }));
    rawBars[19] = { ...rawBars[19]!, adjustedClose: 0 };
    const result = computeTechnicalIndicators({ bars: rawBars });
    expect(result.indicators?.lastClose).toBe(100);
    expect(result.indicators?.sma20).toBeCloseTo(100, 8);

    const adjustedBars = Array.from({ length: 20 }, (_, i) => bar(i, { close: 100, factor: 0.5 }));
    const adjusted = computeTechnicalIndicators({ bars: adjustedBars }).indicators!;
    expect(adjusted.nearestSupport).toBeCloseTo(49, 8);
    expect(adjusted.nearestResistance).toBeCloseTo(51, 8);
  });
});
