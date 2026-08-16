'use client';

/**
 * C4 · 风险矩阵 3×3（visualization PRD §5.1）。
 * likelihood × impact 网格 + 点击展开机制/监控指标 —— V4 出口之一。
 */

import { useState } from 'react';

export interface RiskItem {
  title: string;
  likelihood?: string;
  impact?: string;
  mechanism?: string;
  indicators?: string[];
  evidence?: Array<{ claim?: string; citations?: Array<{ title?: string; url?: string }> }>;
}

const LEVELS = ['LOW', 'MEDIUM', 'HIGH'] as const;
const LEVEL_CN: Record<string, string> = { LOW: '低', MEDIUM: '中', HIGH: '高' };

function cellTone(score: number): string {
  if (score >= 4) return 'rgba(239,91,91,0.10)';
  if (score >= 2) return 'rgba(230,162,60,0.08)';
  return 'rgba(62,207,142,0.05)';
}
function dotColor(score: number): string {
  if (score >= 4) return 'var(--color-signal-bearish)';
  if (score >= 2) return 'var(--color-warn)';
  return 'var(--color-signal-bullish)';
}

export function RiskMatrix({ risks }: { risks: RiskItem[] }) {
  const [active, setActive] = useState<number | null>(null);
  const placed = risks
    .map((r, i) => ({ ...r, index: i }))
    .filter((r) => LEVELS.includes(r.likelihood as never) && LEVELS.includes(r.impact as never));
  if (placed.length === 0) return null;

  return (
    <div className="grid gap-4 sm:grid-cols-[auto_1fr]">
      <div>
        <div className="mb-1 text-[10px] text-[var(--color-fg-3)]">影响 →</div>
        <div
          className="grid gap-1"
          style={{ gridTemplateColumns: 'repeat(3, 58px)', gridTemplateRows: 'repeat(3, 52px)' }}
          role="group"
          aria-label={`风险矩阵，共 ${placed.length} 项风险`}
        >
          {[...LEVELS].reverse().map((impact) =>
            LEVELS.map((likelihood) => {
              const cell = placed.filter((r) => r.likelihood === likelihood && r.impact === impact);
              const score = LEVELS.indexOf(likelihood) + LEVELS.indexOf(impact);
              return (
                <div
                  key={`${likelihood}-${impact}`}
                  className="relative rounded-[7px] border border-[var(--color-border-soft)]"
                  style={{ background: cellTone(score) }}
                >
                  {cell.map((r) => (
                    <button
                      key={r.index}
                      type="button"
                      onClick={() => setActive(active === r.index ? null : r.index)}
                      title={r.title}
                      aria-label={`${r.title}：概率${LEVEL_CN[r.likelihood!]}，影响${LEVEL_CN[r.impact!]}`}
                      className="absolute flex h-[22px] w-[22px] items-center justify-center rounded-full border-[1.5px] text-[10.5px] font-bold"
                      style={{
                        left: `${4 + (cell.indexOf(r) % 2) * 28}px`,
                        top: `${4 + Math.floor(cell.indexOf(r) / 2) * 25}px`,
                        color: dotColor(score),
                        borderColor: dotColor(score),
                        background: `color-mix(in srgb, ${dotColor(score)} 16%, transparent)`,
                        outline: active === r.index ? '2px solid var(--color-accent)' : 'none',
                      }}
                    >
                      {r.index + 1}
                    </button>
                  ))}
                </div>
              );
            }),
          )}
        </div>
        <div className="mt-1 text-[10px] text-[var(--color-fg-3)]">← 发生概率</div>
      </div>

      <div className="min-h-[120px]">
        {active === null ? (
          <ol className="m-0 list-decimal space-y-1 pl-5 text-[12px] text-[var(--color-fg-2)]">
            {placed.map((r) => (
              <li key={r.index}>
                <button type="button" className="text-left hover:text-[var(--color-accent)]" onClick={() => setActive(r.index)}>
                  {r.title}
                </button>
                <span className="ml-1.5 text-[10.5px] text-[var(--color-fg-3)]">
                  概率{LEVEL_CN[r.likelihood!]} · 影响{LEVEL_CN[r.impact!]}
                </span>
              </li>
            ))}
          </ol>
        ) : (
          (() => {
            const r = risks[active]!;
            return (
              <div className="rounded-[8px] border border-[var(--color-border-soft)] bg-[var(--color-elev-2)] px-3 py-2.5">
                <p className="m-0 text-[13px] font-semibold">
                  {active + 1}. {r.title}
                </p>
                <p className="m-0 mt-1 text-[12px] leading-[1.7] text-[var(--color-fg-2)]">
                  <b className="text-[var(--color-fg)]">机制</b>：{r.mechanism ?? '—'}
                </p>
                {r.indicators?.length ? (
                  <p className="m-0 mt-1 text-[11.5px] text-[var(--color-fg-3)]">
                    <b className="text-[var(--color-fg-2)]">监控指标</b>：{r.indicators.join(' · ')}
                  </p>
                ) : null}
                {r.evidence?.flatMap((item) => item.citations ?? []).filter((citation) => citation.url).length ? (
                  <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[11px]">
                    {r.evidence.flatMap((item) => item.citations ?? []).filter((citation) => citation.url).map((citation, index) => (
                      <a key={`${citation.url}-${index}`} href={citation.url} target="_blank" rel="noreferrer" className="text-[var(--color-accent)] hover:underline">
                        {citation.title ?? citation.url}
                      </a>
                    ))}
                  </div>
                ) : null}
                <button
                  type="button"
                  className="mt-2 text-[11px] text-[var(--color-accent)] hover:underline"
                  onClick={() => setActive(null)}
                >
                  ← 返回风险列表
                </button>
              </div>
            );
          })()
        )}
      </div>
    </div>
  );
}
