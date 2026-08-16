'use client';

/**
 * C10 · 北向资金流时序（CN，visualization PRD §5.2）。
 * 沪股通+深股通每日净流入（亿元）柱状 + 最新持股快照徽标（披露停更后
 * 仅季度快照，如实标注"截至"日期）。
 */

export interface NorthboundRow {
  date: string;
  hgt: number;
  sgt: number;
}

export interface NorthboundHoldingRow {
  date: string;
  exchange?: string;
  holdingShares: number;
  holdingPercentOfFloat?: number | null;
  holdingMarketValue?: number | null;
}

const W = 460;
const H = 120;
const PL = 6;
const PR = 6;
const PB = 16;

export function NorthboundChart({
  rows,
  holdings = [],
}: {
  rows: NorthboundRow[];
  holdings?: NorthboundHoldingRow[];
}) {
  if (rows.length === 0 && holdings.length === 0) return null;
  if (rows.length === 0) {
    const ordered = [...holdings].sort((a, b) => (a.date < b.date ? -1 : 1));
    return (
      <div className="space-y-1.5 text-[11.5px] text-[var(--color-fg-2)]">
        <p className="m-0 text-[11px] text-[var(--color-fg-3)]">暂无可验证的每日北向净流入；以下为最近持股披露。</p>
        {ordered.map((row) => (
          <div key={`${row.date}-${row.exchange ?? ''}`} className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="font-mono text-[var(--color-fg-3)]">截至 {row.date}</span>
            <span>持股 {row.holdingShares.toLocaleString()} 万股</span>
            {row.holdingPercentOfFloat != null ? <b className="font-mono">{(row.holdingPercentOfFloat * 100).toFixed(2)}%</b> : null}
            {row.exchange ? <span className="text-[var(--color-fg-3)]">{row.exchange}</span> : null}
          </div>
        ))}
      </div>
    );
  }
  const series = [...rows].sort((a, b) => (a.date < b.date ? -1 : 1));
  const nets = series.map((r) => r.hgt + r.sgt);
  const maxAbs = Math.max(...nets.map((v) => Math.abs(v)), 0.01);
  const zero = PB + ((H - PB - 6) / 2);
  const scale = (H - PB - 10) / 2 / maxAbs;
  const bw = Math.max(1.5, (W - PL - PR) / series.length * 0.7);

  const lastPositive = nets[nets.length - 1]! >= 0;
  const latestHolding = holdings.length > 0
    ? [...holdings].sort((a, b) => (a.date < b.date ? 1 : -1))[0]
    : undefined;

  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={`北向资金流：近 ${series.length} 日净流入`}>
        <line x1={PL} x2={W - PR} y1={zero} y2={zero} stroke="var(--color-border)" strokeWidth={1} />
        {series.map((r, i) => {
          const net = nets[i]!;
          const x = PL + ((W - PL - PR) / series.length) * i + ((W - PL - PR) / series.length - bw) / 2;
          const h = Math.abs(net) * scale;
          return (
            <rect
              key={r.date}
              x={x}
              y={net >= 0 ? zero - h : zero}
              width={bw}
              height={Math.max(1, h)}
              rx={1}
              fill={net >= 0 ? 'var(--color-signal-bullish)' : 'var(--color-signal-bearish)'}
              opacity={0.75}
            >
              <title>{`${r.date}：净流入 ${net.toFixed(2)} 亿（沪 ${r.hgt.toFixed(2)} / 深 ${r.sgt.toFixed(2)}）`}</title>
            </rect>
          );
        })}
        <text x={PL + 2} y={10} fontSize={9.5} fill="var(--color-fg-3)">
          每日净流入（亿元）· 绿=净买 红=净卖
        </text>
      </svg>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-[var(--color-fg-2)]">
        <span className={lastPositive ? 'text-[var(--color-signal-bullish)]' : 'text-[var(--color-signal-bearish)]'}>
          {lastPositive ? '↑' : '↓'} 最近一日净{lastPositive ? '流入' : '流出'} {Math.abs(nets[nets.length - 1]!).toFixed(2)} 亿
        </span>
        {latestHolding ? (
          <span className="text-[var(--color-fg-3)]">
            持股快照截至 {latestHolding.date} · {latestHolding.holdingShares.toLocaleString()} 万股
            {latestHolding.holdingPercentOfFloat != null ? ` · ${(latestHolding.holdingPercentOfFloat * 100).toFixed(2)}% 流通股` : ''}
          </span>
        ) : null}
      </div>
    </div>
  );
}
