'use client';

/**
 * C5 · 财务趋势柱线组合（visualization PRD §5.1）。
 * 营收柱（左轴）+ 利润率线（右轴），每柱标 YoY。数据来自
 * computedFacts.ratios.periodTrends（服务端已归一单位，前端零计算 P1）。
 */

export interface PeriodTrend {
  period: string;
  revenue?: number | null;
  netIncome?: number | null;
  grossMargin?: number | null;
  netMargin?: number | null;
  operatingCashFlow?: number | null;
}

function fmtRevenue(v: number): string {
  if (Math.abs(v) >= 1e12) return `${(v / 1e12).toFixed(1)}万亿`;
  if (Math.abs(v) >= 1e8) return `${(v / 1e8).toFixed(0)}亿`;
  if (Math.abs(v) >= 1e4) return `${(v / 1e4).toFixed(0)}万`;
  return v.toFixed(0);
}

const W = 460;
const H = 200;
const PL = 8;
const PR = 8;
const PT = 18;
const PB = 26;

export function ComboBarLine({ trends }: { trends: PeriodTrend[] }) {
  const rows = trends.filter((t) => Number.isFinite(t.revenue ?? NaN) || Number.isFinite(t.netMargin ?? NaN));
  if (rows.length === 0) return null;

  const revs = rows.map((t) => t.revenue).filter((v): v is number => Number.isFinite(v));
  const margins = rows.map((t) => (t.netMargin != null ? t.netMargin * 100 : null));
  const revMax = revs.length ? Math.max(...revs) * 1.12 : 1;
  const mVals = margins.filter((v): v is number => v != null);
  const mMin = mVals.length ? Math.min(...mVals) * 0.8 : 0;
  const mMax = mVals.length ? Math.max(...mVals) * 1.2 : 1;

  const slot = (W - PL - PR) / rows.length;
  const cx = (i: number) => PL + slot * i + slot / 2;
  const yRev = (v: number) => PT + (1 - v / revMax) * (H - PT - PB);
  const yMargin = (v: number) => PT + (1 - (v - mMin) / (mMax - mMin || 1)) * (H - PT - PB);

  const lineD = margins
    .map((m, i) => (m == null ? null : { i, m }))
    .filter((p): p is { i: number; m: number } => p !== null)
    .map((p, idx) => `${idx === 0 ? 'M' : 'L'}${cx(p.i).toFixed(1)},${yMargin(p.m).toFixed(1)}`)
    .join(' ');

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label="财务趋势：营收柱状图与净利率折线">
      {[0.25, 0.5, 0.75, 1].map((f) => (
        <line key={f} x1={PL} x2={W - PR} y1={yRev(revMax * f)} y2={yRev(revMax * f)} stroke="var(--color-border)" strokeWidth={0.6} />
      ))}

      {rows.map((t, i) => {
        if (!Number.isFinite(t.revenue ?? NaN)) return null;
        const v = t.revenue!;
        const prev = i > 0 ? rows[i - 1]?.revenue : undefined;
        const yoy = prev && Number.isFinite(prev) ? (v / prev - 1) * 100 : null;
        const bw = slot * 0.52;
        return (
          <g key={t.period}>
            <rect
              x={cx(i) - bw / 2}
              y={yRev(v)}
              width={bw}
              height={Math.max(2, yRev(0) - yRev(v))}
              rx={3}
              fill="var(--color-accent)"
              opacity={0.72}
            />
            {yoy !== null ? (
              <text
                x={cx(i)}
                y={yRev(v) - 13}
                textAnchor="middle"
                fontSize={9}
                fill={yoy >= 0 ? 'var(--color-signal-bullish)' : 'var(--color-signal-bearish)'}
              >
                {yoy >= 0 ? '+' : ''}
                {yoy.toFixed(0)}%
              </text>
            ) : null}
            <text x={cx(i)} y={H - 12} textAnchor="middle" fontSize={9.5} fill="var(--color-fg-3)">
              {t.period}
            </text>
            <title>{`${t.period}：营收 ${fmtRevenue(v)}${t.netMargin != null ? `，净利率 ${(t.netMargin * 100).toFixed(1)}%` : ''}`}</title>
          </g>
        );
      })}

      {lineD ? <path d={lineD} fill="none" stroke="var(--color-warn)" strokeWidth={1.8} /> : null}
      {margins.map((m, i) =>
        m == null ? null : (
          <circle key={i} cx={cx(i)} cy={yMargin(m)} r={3} fill="var(--color-warn)" />
        ),
      )}

      <text x={W - 4} y={PT - 6} textAnchor="end" fontSize={9.5} fill="var(--color-warn)">
        净利率（右轴 {mMin.toFixed(0)}–{mMax.toFixed(0)}%）
      </text>
      <text x={PL + 2} y={PT - 6} fontSize={9.5} fill="var(--color-fg-3)">
        营收（峰值 {fmtRevenue(revMax)}）
      </text>
    </svg>
  );
}
