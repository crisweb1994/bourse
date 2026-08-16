'use client';

/**
 * C7 · 财报跨期趋势图（visualization PRD §5.1，earnings-trend-panel 升级）。
 * 通用指标柱图 + 同比折线（泛化版：label 由调用方传入）。数据来自
 * earnings trends 端点（服务端结构化事实，前端零计算 P1）。
 * - 仅 kind=scalar 的点位画柱（range 点如实跳过并在图注说明）
 * - YTD_DIFFERENCE 推导期 → 柱身纹理
 * - reconcileStatus=CONFLICT → 柱描边警示
 */

const W = 460;
const H = 190;
const PL = 8;
const PR = 8;
const PT = 18;
const PB = 24;
const MAX_TICKS = 7;

export interface MetricTrendPoint {
  period: string;
  value: number | null;
  yoyPct: number | null;
  derived?: boolean;
  conflict?: boolean;
}

function shortLabel(p: string): string {
  // periodEndOn 形如 2024-09-27 → 24/09；其余截断
  const m = /^(\d{4})-(\d{2})/.exec(p);
  if (m) return `${m[1]!.slice(2)}/${m[2]}`;
  return p.length > 6 ? `${p.slice(0, 6)}…` : p;
}

export function MetricTrendChart({
  points,
  valueLabel,
  unit,
  onPointClick,
}: {
  points: MetricTrendPoint[];
  valueLabel: string;
  unit?: string;
  onPointClick?: (period: string) => void;
}) {
  const rows = points.filter((p) => p.value !== null);
  if (rows.length === 0) return null;
  const singlePeriod = rows.length === 1;

  const values = rows.map((p) => p.value!);
  const neg = values.some((v) => v < 0);
  const vMax = Math.max(...values) * 1.12 || 1;
  const vMin = neg ? Math.min(...values) * 1.15 : 0;
  const yoyVals = rows.map((p) => p.yoyPct).filter((v): v is number => v !== null);
  const yMaxRaw = yoyVals.length ? Math.max(...yoyVals) : 1;
  const yMinRaw = yoyVals.length ? Math.min(...yoyVals) : 0;
  // Review P2 fix: 全正序列下 min*1.2 会把最低点裁出绘图区 — 向下留 20% 余量
  const yMax = yMaxRaw >= 0 ? yMaxRaw * 1.2 : yMaxRaw * 0.8;
  const yMin = yMinRaw >= 0 ? yMinRaw * 0.8 : yMinRaw * 1.2;

  const slot = (W - PL - PR) / rows.length;
  const cx = (i: number) => PL + slot * i + slot / 2;
  const yVal = (v: number) => PT + (1 - (v - vMin) / (vMax - vMin || 1)) * (H - PT - PB);
  const yYoy = (v: number) => PT + (1 - (v - yMin) / (yMax - yMin || 1)) * (H - PT - PB);

  const step = Math.max(1, Math.ceil(rows.length / MAX_TICKS));
  const hasTick = (i: number) => i === 0 || i === rows.length - 1 || i % step === 0;

  const lineD = rows
    .map((p, i) => (p.yoyPct === null ? null : { i, v: p.yoyPct }))
    .filter((x): x is { i: number; v: number } => x !== null)
    .map((x, idx) => `${idx === 0 ? 'M' : 'L'}${cx(x.i).toFixed(1)},${yYoy(x.v).toFixed(1)}`)
    .join(' ');

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={`${valueLabel} ${singlePeriod ? '单期数值' : '跨期趋势柱状图与同比折线'}`}>
      <defs>
        <pattern id="metric-ytd" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width="6" height="6" fill="var(--color-accent)" opacity="0.35" />
          <line x1="0" y1="0" x2="0" y2="6" stroke="var(--color-accent)" strokeWidth="6" opacity="0.5" />
        </pattern>
      </defs>
      <line x1={PL} x2={W - PR} y1={yVal(0)} y2={yVal(0)} stroke="var(--color-border)" strokeWidth={1} />

      {rows.map((p, i) => {
        const v = p.value!;
        const bw = Math.min(slot * 0.56, 34);
        const top = v >= 0 ? yVal(v) : yVal(0);
        const h = Math.max(2, Math.abs(yVal(v) - yVal(0)));
        return (
          <g key={`${p.period}-${i}`}>
            <rect
              x={cx(i) - bw / 2}
              y={top}
              width={bw}
              height={h}
              rx={2.5}
              fill={p.derived ? 'url(#metric-ytd)' : 'var(--color-accent)'}
              opacity={p.derived ? 1 : 0.72}
              stroke={p.conflict ? 'var(--color-warn)' : 'none'}
              strokeWidth={p.conflict ? 2 : 0}
              role={onPointClick ? 'button' : undefined}
              tabIndex={onPointClick ? 0 : undefined}
              aria-label={onPointClick ? `${p.period} ${valueLabel}，点击查看来源` : undefined}
              onClick={() => onPointClick?.(p.period)}
              onKeyDown={(event) => {
                if (onPointClick && (event.key === 'Enter' || event.key === ' ')) {
                  event.preventDefault();
                  onPointClick(p.period);
                }
              }}
            >
              <title>{`${p.period}：${v.toLocaleString()}${unit ?? ''}${p.yoyPct !== null ? `，同比 ${p.yoyPct >= 0 ? '+' : ''}${p.yoyPct.toFixed(1)}%` : ''}${p.derived ? '（YTD 差分推导）' : ''}${p.conflict ? '（对账冲突）' : ''}`}</title>
            </rect>
            <text x={cx(i)} y={H - 8} textAnchor="middle" fontSize={9.5} fill="var(--color-fg-3)" opacity={hasTick(i) ? 1 : 0}>
              {shortLabel(p.period)}
            </text>
          </g>
        );
      })}

      {lineD ? <path d={lineD} fill="none" stroke="var(--color-warn)" strokeWidth={1.8} /> : null}
      {rows.map((p, i) =>
        p.yoyPct === null ? null : (
          <circle key={`y-${i}`} cx={cx(i)} cy={yYoy(p.yoyPct)} r={2.6} fill="var(--color-warn)" />
        ),
      )}

      <text x={PL + 2} y={PT - 6} fontSize={9.5} fill="var(--color-fg-3)">
        {valueLabel}
        {unit ? `（${unit}）` : ''}
      </text>
      <text x={W - 4} y={PT - 6} textAnchor="end" fontSize={9.5} fill="var(--color-warn)">
        同比%
      </text>
      {singlePeriod ? (
        <text x={W - 4} y={H - 8} textAnchor="end" fontSize={9.5} fill="var(--color-fg-3)">
          仅 1 期，无法比较趋势
        </text>
      ) : null}
    </svg>
  );
}
