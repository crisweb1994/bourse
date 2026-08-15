'use client';

/**
 * C13 · 行内 sparkline（watchlist 迷你走势，visualization PRD §5.2）。
 * 纯 SVG polyline，涨跌语义色由数据首尾决定（server 端价格序列的呈现，
 * 非计算）。anomalyDot 可选标注异常点位。
 */

export function Sparkline({
  closes,
  width = 120,
  height = 26,
  upColor = 'var(--color-signal-bullish)',
  downColor = 'var(--color-signal-bearish)',
  anomalyIndex,
}: {
  closes: number[];
  width?: number;
  height?: number;
  upColor?: string;
  downColor?: string;
  anomalyIndex?: number;
}) {
  if (!closes || closes.length < 3) return null;
  const lo = Math.min(...closes);
  const hi = Math.max(...closes);
  const span = hi - lo || 1;
  const x = (i: number) => (i / (closes.length - 1)) * width;
  const y = (v: number) => height - 3 - ((v - lo) / span) * (height - 6);
  const up = closes[closes.length - 1]! >= closes[0]!;
  const color = up ? upColor : downColor;

  const d = closes.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`近 ${closes.length} 日走势${up ? '上行' : '下行'}`}>
      <path d={`${d} L${width},${height} L0,${height} Z`} fill={color} opacity={0.1} />
      <path d={d} fill="none" stroke={color} strokeWidth={1.4} />
      {anomalyIndex !== undefined && anomalyIndex >= 0 && anomalyIndex < closes.length ? (
        <circle cx={x(anomalyIndex)} cy={y(closes[anomalyIndex]!)} r={2.8} fill="var(--color-warn)" />
      ) : null}
    </svg>
  );
}
