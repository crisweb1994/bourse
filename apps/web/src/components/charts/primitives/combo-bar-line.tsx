'use client';

/**
 * C5 · 财务趋势柱线组合（visualization PRD §5.1）。
 * 营收柱（左轴）+ 净利率线（右轴）。数据来自 computedFacts.ratios.periodTrends
 * （服务端已归一单位，前端零计算 P1）。
 *
 * 2026-08-15 修订（CN 22 期实测反馈）：
 *  - 横轴标签抽稀：最多 ~7 个可见刻度（首/尾必显，中间按步长取），
 *    缩短格式（Q1-FY2022→22Q1、FY2021→2021、2024-12→24/12、TTM*→TTM）
 *  - 图例移出绘图区（顶部 HTML 行），不再与高柱的 YoY 标注互相重叠
 *  - YoY 标注仅在柱宽足够或该柱带刻度时显示，避免密集柱群糊成一片
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

/** Q1-FY2022 → 22Q1；FY2021 → 2021；2024-12 → 24/12；TTM-as-of… → TTM。 */
function shortPeriod(p: string): string {
  let m = /^Q([1-4])-FY(\d{4})$/.exec(p);
  if (m) return `${m[2]!.slice(2)}Q${m[1]}`;
  m = /^(\d{4})-(\d{2})$/.exec(p);
  if (m) return `${m[1]!.slice(2)}/${m[2]}`;
  if (/^FY\d{4}$/.test(p)) return p.slice(2);
  if (p.startsWith('TTM')) return 'TTM';
  return p.length > 6 ? `${p.slice(0, 6)}…` : p;
}

/** 期次口径：季度 / 年度 / TTM / 月。跨口径相邻比较（季度 vs 年度）会产出
 *  ±300% 式的假变化，只有同口径相邻期才显示变化标注（诚实原则）。 */
function periodKind(p: string): string {
  if (p.startsWith('Q')) return 'quarter';
  if (p.startsWith('FY')) return 'annual';
  if (p.startsWith('TTM')) return 'ttm';
  if (/^\d{4}-\d{2}$/.test(p)) return 'month';
  return 'other';
}

const W = 460;
const H = 210;
const PL = 8;
const PR = 8;
const PT = 10;
const PB = 22;
const MAX_TICKS = 7;

export function ComboBarLine({ trends }: { trends: PeriodTrend[] }) {
  // periodTrends 按最新在前持久化（bundle 约定）；趋势图时间向右，先反转。
  // 反转同时保证 YoY 的"上一期"取到更早的期次（原顺序下方向相反）。
  const rows = trends
    .filter(
      (t) => Number.isFinite(t.revenue ?? NaN) || Number.isFinite(t.netMargin ?? NaN),
    )
    .slice()
    .reverse();
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

  // 横轴刻度抽稀：步长取整，首/尾必显
  const step = Math.max(1, Math.ceil(rows.length / MAX_TICKS));
  const hasTick = (i: number) => i === 0 || i === rows.length - 1 || i % step === 0;
  // YoY 只在柱子够宽或带刻度的柱上显示
  const showYoy = (i: number) => slot >= 34 || hasTick(i);

  const lineD = margins
    .map((m, i) => (m == null ? null : { i, m }))
    .filter((p): p is { i: number; m: number } => p !== null)
    .map((p, idx) => `${idx === 0 ? 'M' : 'L'}${cx(p.i).toFixed(1)},${yMargin(p.m).toFixed(1)}`)
    .join(' ');

  return (
    <figure className="m-0" role="group" aria-label="财务趋势图">
      <div className="mb-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-[var(--color-fg-3)]">
        <span className="inline-flex items-center gap-1.5">
          <i className="block h-[9px] w-[9px] rounded-[2px] bg-[var(--color-accent)] opacity-75" aria-hidden />
          营收（峰值 {fmtRevenue(revMax)}）
        </span>
        <span className="inline-flex items-center gap-1.5">
          <i className="block h-[2px] w-[14px] rounded bg-[var(--color-warn)]" aria-hidden />
          净利率（{mMin.toFixed(0)}–{mMax.toFixed(0)}%）
        </span>
        {rows.length > MAX_TICKS ? (
          <span className="ml-auto font-mono text-[10px]">共 {rows.length} 期</span>
        ) : null}
      </div>

      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label="营收柱状图与净利率折线组合图">
        {[0.25, 0.5, 0.75, 1].map((f) => (
          <line
            key={f}
            x1={PL}
            x2={W - PR}
            y1={yRev(revMax * f)}
            y2={yRev(revMax * f)}
            stroke="var(--color-border)"
            strokeWidth={0.6}
          />
        ))}

        {rows.map((t, i) => {
          if (!Number.isFinite(t.revenue ?? NaN)) return null;
          const v = t.revenue!;
          const prevRow = i > 0 ? rows[i - 1] : undefined;
          const prev =
            prevRow?.period !== undefined &&
            periodKind(prevRow.period) === periodKind(t.period) &&
            periodKind(t.period) !== 'other'
              ? prevRow.revenue
              : undefined;
          const change = prev && Number.isFinite(prev) ? (v / prev - 1) * 100 : null;
          const bw = Math.min(slot * 0.56, 34);
          const last = i === rows.length - 1;
          return (
            <g key={t.period}>
              <rect
                x={cx(i) - bw / 2}
                y={yRev(v)}
                width={bw}
                height={Math.max(2, yRev(0) - yRev(v))}
                rx={2.5}
                fill="var(--color-accent)"
                opacity={last ? 0.95 : 0.72}
              />
              {change !== null && showYoy(i) ? (
                <text
                  x={cx(i)}
                  y={yRev(v) - 5}
                  textAnchor="middle"
                  fontSize={9}
                  fontWeight={last ? 700 : 400}
                  fill={change >= 0 ? 'var(--color-signal-bullish)' : 'var(--color-signal-bearish)'}
                >
                  {change >= 0 ? '+' : ''}
                  {change.toFixed(0)}%
                </text>
              ) : null}
              <title>{`${t.period}：营收 ${fmtRevenue(v)}${t.netMargin != null ? `，净利率 ${(t.netMargin * 100).toFixed(1)}%` : ''}${change !== null ? `，较上一${periodKind(t.period) === 'annual' ? '年度' : '期'} ${change >= 0 ? '+' : ''}${change.toFixed(1)}%` : ''}`}</title>
            </g>
          );
        })}

        {lineD ? <path d={lineD} fill="none" stroke="var(--color-warn)" strokeWidth={2} /> : null}
        {margins.map((m, i) =>
          m == null ? null : (
            <circle key={i} cx={cx(i)} cy={yMargin(m)} r={2.6} fill="var(--color-warn)" />
          ),
        )}

        {/* 横轴刻度：抽稀 + 缩短 + 竖刻度线 */}
        {rows.map((t, i) =>
          hasTick(i) ? (
            <g key={`tick-${t.period}`}>
              <line
                x1={cx(i)}
                x2={cx(i)}
                y1={H - PB + 2}
                y2={H - PB + 6}
                stroke="var(--color-fg-3)"
                strokeWidth={1}
              />
              <text
                x={cx(i)}
                y={H - 6}
                textAnchor={i === 0 ? 'start' : i === rows.length - 1 ? 'end' : 'middle'}
                fontSize={10}
                fill={i === rows.length - 1 ? 'var(--color-fg-2)' : 'var(--color-fg-3)'}
              >
                {shortPeriod(t.period)}
              </text>
            </g>
          ) : null,
        )}
        <line x1={PL} x2={W - PR} y1={H - PB + 2} y2={H - PB + 2} stroke="var(--color-border)" strokeWidth={1} />
      </svg>
    </figure>
  );
}
