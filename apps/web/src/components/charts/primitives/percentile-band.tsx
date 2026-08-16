'use client';

/**
 * C2 · PE 历史 + 5 年分位带（visualization PRD §5.1）。
 * 每财年一点（peHistorySeries 是 FY 序列，稀疏是特性 —— 估值以财年为节拍，
 * 不做日频插值）。I11（v2.2）：peHistorySeries < 3 点 → 上层应渲染空态，
 * 本组件只处理 ready 数据。
 */

export interface PeHistoryPoint {
  period: string;
  pe: number;
  eps?: number;
  closePrice?: number;
}

export interface PercentileBandProps {
  series: PeHistoryPoint[];
  currentPe?: number | null;
  percentile?: number | null;
  high?: number | null;
  median?: number | null;
  low?: number | null;
  currency?: string;
  onCurrentClick?: () => void;
}

const W = 460;
const H = 200;
const PL = 8;
const PR = 42;
const PT = 12;
const PB = 24;

export function PercentileBand({
  series,
  currentPe,
  percentile,
  high,
  median,
  low,
  onCurrentClick,
}: PercentileBandProps) {
  const points = series.filter((p) => Number.isFinite(p.pe));
  if (points.length === 0) return null;
  const values = points.map((p) => p.pe).sort((a, b) => a - b);
  const p30 = percentileOf(values, 0.3);
  const p70 = percentileOf(values, 0.7);
  const current = typeof currentPe === 'number' && Number.isFinite(currentPe) ? currentPe : null;
  const lo = Math.min(...values, low ?? Infinity, p30, p70, current ?? Infinity);
  const hi = Math.max(...values, high ?? -Infinity, p30, p70, current ?? -Infinity);
  const pad = (hi - lo) * 0.08 || 1;
  const yMin = lo - pad;
  const yMax = hi + pad;

  const x = (i: number) => PL + (i * (W - PL - PR)) / Math.max(points.length - 1, 1);
  const y = (v: number) => PT + ((yMax - v) / (yMax - yMin)) * (H - PT - PB);

  // Zones use the actual PE distribution, not an arbitrary 0–100% slice of
  // the y-axis. This keeps the visual meaning aligned with the percentile
  // label even when the historical range is skewed.
  const zones: Array<{ from: number; to: number; color: string }> = [
    { from: yMin, to: p30, color: 'rgba(62,207,142,0.06)' },
    { from: p30, to: p70, color: 'rgba(139,150,171,0.05)' },
    { from: p70, to: yMax, color: 'rgba(239,91,91,0.07)' },
  ];

  const d = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.pe).toFixed(1)}`).join(' ');

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label="PE 历史与分位带">
      {zones.map((z) => (
        <rect
          key={z.color}
          x={PL}
          y={y(z.to)}
          width={W - PL - PR}
          height={Math.max(0, y(z.from) - y(z.to))}
          fill={z.color}
        />
      ))}
      {[[high, '5y 高'], [median, '5y 中位'], [low, '5y 低']].map(([v, label], idx) =>
        typeof v === 'number' && Number.isFinite(v) ? (
          <g key={idx}>
            <line x1={PL} x2={W - PR} y1={y(v)} y2={y(v)} stroke="var(--color-fg-3)" strokeWidth={0.8} strokeDasharray="5 4" />
            <text x={PL + 4} y={y(v) - 3} fontSize={9.5} fill="var(--color-fg-3)">
              {label as string} {v.toFixed(1)}
            </text>
          </g>
        ) : null,
      )}

      {current !== null ? (
        <g
          role={onCurrentClick ? 'button' : undefined}
          tabIndex={onCurrentClick ? 0 : undefined}
          aria-label={onCurrentClick ? '跳转到估值模块中当前 PE 的依据' : undefined}
          onClick={onCurrentClick}
          onKeyDown={(event) => {
            if (onCurrentClick && (event.key === 'Enter' || event.key === ' ')) {
              event.preventDefault();
              onCurrentClick();
            }
          }}
          style={{ cursor: onCurrentClick ? 'pointer' : undefined }}
        >
          <circle cx={x(points.length - 1)} cy={y(current)} r={11} fill="none" stroke="var(--color-warn)" strokeWidth={1.2} opacity={0.8} />
          <circle cx={x(points.length - 1)} cy={y(current)} r={4.5} fill="var(--color-warn)" stroke="var(--color-elev)" strokeWidth={1.5} />
          <text
            x={x(points.length - 1)}
            y={Math.min(y(current) + 24, H - 4)}
            textAnchor="middle"
            fontSize={10}
            fontWeight={700}
            fill="var(--color-warn)"
          >
            当前 {current.toFixed(1)}
            {typeof percentile === 'number' ? ` · ${Math.round(percentile)} 分位` : ''}
          </text>
        </g>
      ) : null}

      <path d={d} fill="none" stroke="var(--color-accent)" strokeWidth={1.8} />

      {points.map((p, i) => (
        <circle key={p.period} cx={x(i)} cy={y(p.pe)} r={3} fill="var(--color-elev)" stroke="var(--color-accent)" strokeWidth={1.5} />
      ))}
      {points.map((p, i) => (
        <text key={`l-${p.period}`} x={x(i)} y={H - 8} textAnchor="middle" fontSize={9.5} fill="var(--color-fg-3)">
          {p.period}
        </text>
      ))}
      <text x={W - 2} y={PT + 8} textAnchor="end" fontSize={9.5} fill="var(--color-fg-3)">
        绿 &lt;30% · 中 30–70% · 橙 &gt;70%（5 年区间）
      </text>
    </svg>
  );
}

function percentileOf(sorted: number[], fraction: number): number {
  if (sorted.length === 1) return sorted[0]!;
  const index = (sorted.length - 1) * fraction;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower]!;
  const weight = index - lower;
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * weight;
}
