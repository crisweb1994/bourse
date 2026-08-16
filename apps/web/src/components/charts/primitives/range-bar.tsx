'use client';

/**
 * C3 · 情景价值区间条（visualization PRD §5.1，V6：假设而非预测）。
 * 悬停展开 assumptions 与 invalidators —— 回答"此情景区间成立的前提"，
 * 不提供任何预测线。
 */

import { useState } from 'react';

export interface ScenarioRange {
  case: 'BEAR' | 'BASE' | 'BULL';
  valueRange: { low: number; high: number; currency: string } | null;
  assumptions?: string[];
  invalidators?: string[];
}

const CASE_LABEL: Record<string, string> = { BEAR: '熊市', BASE: '基准', BULL: '牛市' };
const CASE_COLOR: Record<string, string> = {
  BEAR: 'var(--color-signal-bearish)',
  BASE: 'var(--color-fg-2)',
  BULL: 'var(--color-signal-bullish)',
};

export function ScenarioRangeBar({
  scenarios,
  currentPrice,
  currency,
  impliedGrowth,
  codeComputed,
}: {
  scenarios: ScenarioRange[];
  currentPrice: number;
  currency: string;
  /** 反向 DCF：现价隐含增长率（代码计算，如 0.142）。 */
  impliedGrowth?: number | null;
  /** P0（review 2026-08-16）：只有存在代码公允价值时才可声称"代码计算"。 */
  codeComputed?: boolean;
}) {
  const [active, setActive] = useState<string | null>(null);
  const withRange = scenarios.filter((s) => s.valueRange);
  if (withRange.length === 0) return null;

  const lo = Math.min(currentPrice, ...withRange.map((s) => s.valueRange!.low)) * 0.95;
  const hi = Math.max(currentPrice, ...withRange.map((s) => s.valueRange!.high)) * 1.03;
  const px = (v: number) => ((v - lo) / (hi - lo)) * 100;
  const rangeLow = Math.min(...withRange.map((s) => s.valueRange!.low));
  const rangeHigh = Math.max(...withRange.map((s) => s.valueRange!.high));
  const outsideRange = currentPrice < rangeLow || currentPrice > rangeHigh;

  return (
    <div>
      <div className="relative h-[132px]" role="group" aria-label={`情景价值区间图，当前价 ${currentPrice.toFixed(1)} ${currency}`}>
        {[0, 25, 50, 75, 100].map((p) => (
          <span
            key={p}
            aria-hidden
            className="absolute bottom-0 -translate-x-1/2 font-mono text-[9.5px] text-[var(--color-fg-3)]"
            style={{ left: `${p}%` }}
          >
            {(lo + ((hi - lo) * p) / 100).toFixed(0)}
          </span>
        ))}
        {withRange.map((s, i) => {
          const rows = withRange.length;
          const topPct = 12 + (i * 76) / Math.max(rows - 1, 1);
          const left = px(s.valueRange!.low);
          const width = px(s.valueRange!.high) - left;
          const color = CASE_COLOR[s.case];
          const isActive = active === s.case;
          return (
            <div
              key={s.case}
              className="absolute"
              style={{ top: `${topPct}%`, left: 0, right: 0, height: '18px' }}
              onMouseEnter={() => setActive(s.case)}
              onMouseLeave={() => setActive(null)}
              onFocus={() => setActive(s.case)}
              onBlur={() => setActive(null)}
              onClick={() => setActive(active === s.case ? null : s.case)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  setActive(active === s.case ? null : s.case);
                }
              }}
              role="button"
              tabIndex={0}
              aria-label={`${CASE_LABEL[s.case]}区间 ${s.valueRange!.low} 至 ${s.valueRange!.high} ${s.valueRange!.currency}`}
            >
              <span className="absolute left-0 top-px text-[11px] font-semibold" style={{ color }}>
                {CASE_LABEL[s.case]}
              </span>
              <span
                className="absolute h-[14px] rounded-[7px] border"
                style={{
                  left: `${left}%`,
                  width: `${width}%`,
                  top: '2px',
                  background: `color-mix(in srgb, ${color} 24%, transparent)`,
                  borderColor: color,
                  outline: isActive ? `1.5px solid ${color}` : 'none',
                }}
                title={`${s.valueRange!.low}–${s.valueRange!.high} ${s.valueRange!.currency}`}
              />
              <span
                aria-hidden
                className="absolute top-0 font-mono text-[9.5px]"
                style={{ left: `calc(${left}% - 22px)`, color: 'var(--color-fg-3)' }}
              >
                {s.valueRange!.low.toFixed(0)}
              </span>
              <span
                aria-hidden
                className="absolute top-0 font-mono text-[9.5px]"
                style={{ left: `calc(${px(s.valueRange!.high)}% + 4px)`, color: 'var(--color-fg-3)' }}
              >
                {s.valueRange!.high.toFixed(0)}
              </span>
            </div>
          );
        })}
        <span
          aria-hidden
          className="absolute bottom-[16px] w-[2px]"
          style={{ left: `${px(currentPrice)}%`, top: '6px', height: '106px', background: 'var(--color-accent)' }}
        />
        <span
          className="absolute rounded-[4px] px-1.5 py-px text-[10px] font-bold text-white"
          style={{
            left: `${Math.min(Math.max(px(currentPrice) - 26, 0), 86)}%`,
            top: 0,
            background: outsideRange ? 'var(--color-signal-bearish)' : 'var(--color-accent)',
          }}
        >
          现价 {currentPrice.toFixed(1)}
        </span>
      </div>

      {outsideRange ? (
        <p className="m-0 mt-1 text-right text-[10.5px] font-medium text-[var(--color-signal-bearish)]">
          价格已脱离全部情景的假设范围
        </p>
      ) : null}

      <p className="m-0 mt-1 text-right text-[10.5px] text-[var(--color-fg-3)]">
        {typeof impliedGrowth === 'number'
          ? `反向 DCF：现价隐含 ${(impliedGrowth * 100).toFixed(1)}% 增长（WACC 10% · 终值 3% · 10Y，代码计算）`
          : codeComputed
            ? '区间引用代码计算的公允价值'
            : '区间为模型基于快照数据的假设（代码未计算公允价值）'}
      </p>

      {active ? (
        <div className="mt-2 rounded-[8px] border border-[var(--color-border-soft)] bg-[var(--color-elev-2)] px-3 py-2 text-[11.5px] leading-[1.7]">
          {(() => {
            const s = withRange.find((x) => x.case === active)!;
            return (
              <>
                <p className="m-0 text-[var(--color-fg-2)]">
                  <b style={{ color: CASE_COLOR[s.case] }}>{CASE_LABEL[s.case]}假设</b>
                  ：{(s.assumptions ?? []).join('；') || '—'}
                </p>
                <p className="m-0 mt-1 text-[var(--color-warn)]">
                  失效条件：{(s.invalidators ?? []).join('；') || '—'}
                </p>
              </>
            );
          })()}
        </div>
      ) : (
        <p className="m-0 mt-1 text-[10.5px] text-[var(--color-fg-3)]">悬停区间查看假设与失效条件</p>
      )}
    </div>
  );
}
