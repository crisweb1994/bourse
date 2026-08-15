'use client';

/**
 * C11 · 解禁日历时间线（CN，visualization PRD §5.2）。
 * 未来解禁事件水平时间轴，气泡大小 ∝ √市值（亿元）。空结果 = 无待解禁
 * （合法信号，由上层显示"未来 N 天无解禁 ✅"）。
 */

export interface UnlockRow {
  date: string;
  shares?: number | null;
  marketValue?: number | null;
  type?: string | null;
}

const W = 460;
const H = 92;

export function UnlockTimeline({ rows }: { rows: UnlockRow[] }) {
  if (rows.length === 0) return null;
  const events = [...rows]
    .filter((r) => /^\d{4}-\d{2}-\d{2}/.test(r.date ?? ''))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  if (events.length === 0) return null;

  const times = events.map((e) => Date.parse(e.date.slice(0, 10)));
  const tMin = Date.now() - 86_400_000 * 3;
  const tMax = Math.max(...times) + 86_400_000 * 15;
  const x = (t: number) => 26 + ((t - tMin) / (tMax - tMin || 1)) * (W - 52);
  const maxMv = Math.max(...events.map((e) => e.marketValue ?? 0), 1);

  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={`未来解禁 ${events.length} 次`}>
        <line x1={20} x2={W - 20} y1={54} y2={54} stroke="var(--color-border)" strokeWidth={2} />
        {events.map((e) => {
          const t = Date.parse(e.date.slice(0, 10));
          const r = 4 + Math.sqrt(e.marketValue ?? 1) * 0.55;
          const size = Math.min(r, (4 + Math.sqrt(maxMv) * 0.55));
          return (
            <g key={`${e.date}-${e.type ?? ''}`}>
              <circle
                cx={x(t)}
                cy={54}
                r={Math.max(4, size)}
                fill="rgba(239,91,91,0.18)"
                stroke="var(--color-warn)"
                strokeWidth={1.2}
              >
                <title>{`${e.date.slice(0, 10)} 解禁${e.marketValue != null ? ` 约 ¥${Math.round(e.marketValue)} 亿` : ''}${e.type ? ` · ${e.type}` : ''}`}</title>
              </circle>
              <text x={x(t)} y={82} textAnchor="middle" fontSize={8.5} fill="var(--color-fg-3)">
                {e.date.slice(2, 7)}
              </text>
            </g>
          );
        })}
        <text x={2} y={12} fontSize={9.5} fill="var(--color-fg-3)">
          解禁日历（未来）
        </text>
      </svg>
      <ul className="m-0 mt-1 list-none space-y-0.5 p-0 text-[11.5px] text-[var(--color-fg-2)]">
        {events.slice(0, 4).map((e) => (
          <li key={`li-${e.date}-${e.type ?? ''}`} className="flex gap-2">
            <span className="font-mono text-[var(--color-fg-3)]">{e.date.slice(0, 10)}</span>
            <span>
              {e.marketValue != null ? `约 ¥${Math.round(e.marketValue)} 亿` : '市值未知'}
              {e.type ? ` · ${e.type}` : ''}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
