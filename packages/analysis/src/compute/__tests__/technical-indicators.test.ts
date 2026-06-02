import { describe, expect, it } from 'vitest';
import type { PriceBar } from '../..';
import { computeTechnicalIndicators } from '../technical-indicators';

// ============================================================================
// Bar builders
// ============================================================================

function bar(daysAgo: number, close: number, high?: number, low?: number, vol = 1_000_000): PriceBar {
  const d = new Date('2025-05-25T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return {
    timestamp: d.toISOString().slice(0, 10),
    open: close,
    high: high ?? close,
    low: low ?? close,
    close,
    volume: vol,
  };
}

/** Build N bars with given close series (oldest first). */
function bars(closes: number[], volumes?: number[]): PriceBar[] {
  return closes.map((c, i) =>
    bar(closes.length - 1 - i, c, c, c, volumes?.[i] ?? 1_000_000),
  );
}

function flatBars(n: number, close: number): PriceBar[] {
  return bars(new Array<number>(n).fill(close));
}

function linearBars(n: number, start: number, step: number): PriceBar[] {
  return bars(new Array(n).fill(0).map((_, i) => start + step * i));
}

// ============================================================================
// Tests
// ============================================================================

describe('technical-indicators · degraded states', () => {
  it('returns null indicators for empty input', () => {
    const { indicators } = computeTechnicalIndicators({ bars: [] });
    expect(indicators).toBeNull();
  });

  it('returns warning + null when bars are not ascending', () => {
    const out = computeTechnicalIndicators({
      bars: [bar(0, 100), bar(5, 95)], // 2nd timestamp earlier
    });
    expect(out.indicators).toBeNull();
    expect(out.warnings.some((w) => w.metric === 'priceBars')).toBe(true);
  });

  it('SMA200 returns null and emits insufficient_history when <200 bars', () => {
    const { indicators, warnings } = computeTechnicalIndicators({
      bars: flatBars(50, 100),
    });
    expect(indicators!.sma200).toBeNull();
    expect(indicators!.sma50).toBeCloseTo(100, 4);
    expect(warnings.some((w) => w.metric === 'sma200')).toBe(true);
  });
});

describe('technical-indicators · SMA correctness', () => {
  it('SMA equals constant on a flat series', () => {
    const { indicators } = computeTechnicalIndicators({
      bars: flatBars(250, 50),
    });
    expect(indicators!.sma20).toBeCloseTo(50, 6);
    expect(indicators!.sma50).toBeCloseTo(50, 6);
    expect(indicators!.sma200).toBeCloseTo(50, 6);
  });

  it('SMA20 equals last 20 mean on linear series', () => {
    // closes = 1..250
    const { indicators } = computeTechnicalIndicators({
      bars: linearBars(250, 1, 1),
    });
    // last 20 = 231..250 → mean = 240.5
    expect(indicators!.sma20).toBeCloseTo(240.5, 4);
    // last 50 = 201..250 → mean = 225.5
    expect(indicators!.sma50).toBeCloseTo(225.5, 4);
  });
});

describe('technical-indicators · RSI correctness', () => {
  it('RSI on monotonically rising series → close to 100 (no losses)', () => {
    const { indicators } = computeTechnicalIndicators({
      bars: linearBars(50, 10, 1),
    });
    expect(indicators!.rsi14).toBeCloseTo(100, 1);
    expect(indicators!.momentum).toBe('overbought');
  });

  it('RSI on monotonically falling series → close to 0 (no gains)', () => {
    const { indicators } = computeTechnicalIndicators({
      bars: linearBars(50, 100, -1),
    });
    expect(indicators!.rsi14).toBeCloseTo(0, 1);
    expect(indicators!.momentum).toBe('oversold');
  });

  it('RSI on flat series → neutral (no gains, no losses → div0 path → 100)', () => {
    // Edge case: flat series has 0 gain and 0 loss; impl returns 100 (div by 0
    // → +inf RSI = 100). This is the standard convention.
    const { indicators } = computeTechnicalIndicators({
      bars: flatBars(50, 50),
    });
    expect(indicators!.rsi14).toBe(100);
  });
});

describe('technical-indicators · MACD', () => {
  it('returns null MACD when bars < 26 + 9', () => {
    const { indicators } = computeTechnicalIndicators({
      bars: flatBars(30, 100),
    });
    expect(indicators!.macdLine).toBeNull();
  });

  it('MACD line ≈ 0 on flat series, trend = neutral', () => {
    const { indicators } = computeTechnicalIndicators({
      bars: flatBars(60, 100),
    });
    expect(indicators!.macdLine).toBeCloseTo(0, 6);
    expect(indicators!.macdSignal).toBeCloseTo(0, 6);
    expect(indicators!.macdHistogram).toBeCloseTo(0, 6);
    expect(indicators!.macdTrend).toBe('neutral');
  });

  it('MACD trend = bullish on accelerating uptrend (real-world bullish signal)', () => {
    // Quadratic — slope grows over time → MACD line keeps expanding away from
    // signal → histogram > 0. Pure linear converges to plateau (neutral).
    const closes = new Array(80).fill(0).map((_, i) => 10 + i * 0.5 + (i * i) / 100);
    const { indicators } = computeTechnicalIndicators({ bars: bars(closes) });
    expect(indicators!.macdLine!).toBeGreaterThan(0);
    expect(indicators!.macdHistogram!).toBeGreaterThan(0);
    expect(indicators!.macdTrend).toBe('bullish');
  });

  it('MACD trend = bearish on accelerating downtrend', () => {
    const closes = new Array(80).fill(0).map((_, i) => 100 - i * 0.5 - (i * i) / 100);
    const { indicators } = computeTechnicalIndicators({ bars: bars(closes) });
    expect(indicators!.macdLine!).toBeLessThan(0);
    expect(indicators!.macdHistogram!).toBeLessThan(0);
    expect(indicators!.macdTrend).toBe('bearish');
  });

  it('MACD trend = neutral on steady linear trend (post-convergence)', () => {
    // Long enough to converge: line ≈ signal → neutral per epsilon
    const { indicators } = computeTechnicalIndicators({
      bars: linearBars(80, 10, 1),
    });
    expect(indicators!.macdTrend).toBe('neutral');
  });
});

describe('technical-indicators · Bollinger Bands', () => {
  it('flat series → upper = middle = lower (zero variance)', () => {
    const { indicators } = computeTechnicalIndicators({
      bars: flatBars(30, 80),
    });
    expect(indicators!.bollingerMiddle).toBeCloseTo(80, 6);
    expect(indicators!.bollingerUpper).toBeCloseTo(80, 6);
    expect(indicators!.bollingerLower).toBeCloseTo(80, 6);
  });

  it('middle band = SMA20', () => {
    const { indicators } = computeTechnicalIndicators({
      bars: linearBars(50, 1, 1),
    });
    expect(indicators!.bollingerMiddle).toBeCloseTo(indicators!.sma20!, 4);
  });

  it('upper > middle > lower for non-flat series', () => {
    const { indicators } = computeTechnicalIndicators({
      bars: linearBars(50, 1, 1),
    });
    expect(indicators!.bollingerUpper!).toBeGreaterThan(indicators!.bollingerMiddle!);
    expect(indicators!.bollingerMiddle!).toBeGreaterThan(indicators!.bollingerLower!);
  });
});

describe('technical-indicators · ATR', () => {
  it('flat OHLC → ATR = 0', () => {
    const { indicators } = computeTechnicalIndicators({
      bars: flatBars(30, 50),
    });
    expect(indicators!.atr14).toBeCloseTo(0, 6);
  });

  it('ATR > 0 when high > low on every bar', () => {
    const noisyBars = new Array(30).fill(0).map((_, i) => bar(29 - i, 50, 52, 48));
    const { indicators } = computeTechnicalIndicators({ bars: noisyBars });
    expect(indicators!.atr14!).toBeGreaterThan(0);
  });
});

describe('technical-indicators · trend label', () => {
  it('uptrend when close > sma50 > sma200', () => {
    // Linear rising 250 days, close=250, sma50≈225.5, sma200≈150.5
    const { indicators } = computeTechnicalIndicators({
      bars: linearBars(250, 1, 1),
    });
    expect(indicators!.trend).toBe('uptrend');
    expect(indicators!.currentVsSma200).toBe('above');
  });

  it('downtrend when close < sma50 < sma200', () => {
    const { indicators } = computeTechnicalIndicators({
      bars: linearBars(250, 250, -1),
    });
    expect(indicators!.trend).toBe('downtrend');
    expect(indicators!.currentVsSma200).toBe('below');
  });

  it('sideways on flat series', () => {
    const { indicators } = computeTechnicalIndicators({
      bars: flatBars(250, 100),
    });
    expect(indicators!.trend).toBe('sideways');
  });
});

describe('technical-indicators · volume', () => {
  it('volumeVs20dAvg = 2 when last bar volume = 2x avg', () => {
    const vols = [...new Array(20).fill(1_000_000), 2_000_000];
    const { indicators } = computeTechnicalIndicators({
      bars: bars(new Array(21).fill(100), vols),
    });
    expect(indicators!.volumeVs20dAvg).toBeCloseTo(2, 4);
  });

  it('returns null volume metrics when no volume data', () => {
    const noVol: PriceBar[] = new Array(25).fill(0).map((_, i) => ({
      timestamp: new Date(2025, 0, i + 1).toISOString().slice(0, 10),
      open: 100,
      high: 100,
      low: 100,
      close: 100,
    }));
    const { indicators } = computeTechnicalIndicators({ bars: noVol });
    expect(indicators!.volumeVs20dAvg).toBeNull();
  });
});

describe('technical-indicators · meta', () => {
  it('exposes bar count + lastClose + asOf timestamp', () => {
    const series = linearBars(250, 1, 1);
    const { indicators } = computeTechnicalIndicators({ bars: series });
    expect(indicators!.bars).toBe(250);
    expect(indicators!.lastClose).toBe(250);
    // Date-only PriceBar timestamp gets coerced to full ISO datetime
    // (so it satisfies ComputedTechnicalIndicators.asOf zod schema).
    const lastTs = series[series.length - 1]!.timestamp;
    if (/^\d{4}-\d{2}-\d{2}$/.test(lastTs)) {
      expect(indicators!.asOf).toBe(`${lastTs}T00:00:00.000Z`);
    } else {
      expect(indicators!.asOf).toBe(lastTs);
    }
  });

  it('plan-v2 Wave 2.5 regression: date-only bar timestamps coerce to ISO datetime', () => {
    // Real connectors (Yahoo /v8/chart, Eastmoney push2his klines) emit
    // bar timestamps as date-only `YYYY-MM-DD`. Without coercion the
    // resulting indicators.asOf would fail zod schema datetime check.
    const dateOnlyBars: PriceBar[] = Array.from({ length: 30 }, (_, i) => ({
      timestamp: `2025-01-${String(i + 1).padStart(2, '0')}`,
      open: 100,
      high: 100,
      low: 100,
      close: 100,
      volume: 1000,
    }));
    const { indicators } = computeTechnicalIndicators({ bars: dateOnlyBars });
    expect(indicators!.asOf).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
    );
  });
});
