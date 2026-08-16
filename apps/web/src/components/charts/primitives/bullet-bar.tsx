'use client';

/**
 * C8 · 同行分位条（visualization PRD §5.2）。
 * 每条指标独立 bullet：本公司圆点 vs 同行中位数竖线 + 分位标签。
 * V2：维度独立，不合成雷达/总分。只渲染有数据的指标（peer 基本面指标
 * 需逐家财报拉取，当前仅估值口径 pe/pb —— 缺的指标如实跳过）。
 */

export interface BulletRow {
  label: string;
  subject: number | null;
  median: number | null;
  rankPercentile: number | null;
  peerCount: number;
}

const METRIC_LABELS: Array<{ key: string; label: string; fmt: (v: number) => string }> = [
  { key: 'pe', label: 'PE (TTM)', fmt: (v) => v.toFixed(1) },
  { key: 'pb', label: 'PB', fmt: (v) => v.toFixed(1) },
  { key: 'roe', label: 'ROE %', fmt: (v) => v.toFixed(1) },
  { key: 'netMargin', label: '净利率 %', fmt: (v) => v.toFixed(1) },
  { key: 'revenueGrowthYoY', label: '营收增速 %', fmt: (v) => v.toFixed(1) },
];

function pctColor(p: number | null): string {
  if (p === null) return 'var(--color-fg-3)';
  if (p >= 70) return 'var(--color-signal-bearish)'; // 偏贵端
  if (p <= 30) return 'var(--color-signal-bullish)'; // 偏低端
  return 'var(--color-fg-2)';
}

export function PeerBulletBar({
  subjectVsPeerMedian,
}: {
  subjectVsPeerMedian: Record<string, { subject: number | null; median: number | null; rankPercentile: number | null; peerCount: number }>;
}) {
  const rows: BulletRow[] = METRIC_LABELS.filter((m) => {
    const v = subjectVsPeerMedian[m.key];
    return v && (v.subject !== null || v.median !== null);
  }).map((m) => ({
    label: m.label,
    subject: subjectVsPeerMedian[m.key]!.subject,
    median: subjectVsPeerMedian[m.key]!.median,
    rankPercentile: subjectVsPeerMedian[m.key]!.rankPercentile,
    peerCount: subjectVsPeerMedian[m.key]!.peerCount,
  }));
  if (rows.length === 0) return null;

  return (
    <div role="img" aria-label={`同行对比 ${rows.length} 项指标`}>
      {rows.map((row) => {
        const fmt = METRIC_LABELS.find((m) => m.label === row.label)!.fmt;
        const all = [row.subject, row.median].filter((v): v is number => v !== null);
        if (all.length === 0) return null;
        const mn = Math.min(...all) * 0.85;
        const mx = Math.max(...all) * 1.15;
        const span = mx - mn || 1;
        const px = (v: number) => ((v - mn) / span) * 100;
        return (
          <div
            key={row.label}
            className="relative mb-3.5 mt-1 h-[26px]"
            title={`本公司 ${row.subject !== null ? fmt(row.subject) : '—'} vs 同行中位 ${row.median !== null ? fmt(row.median) : '—'} · 分位 P${row.rankPercentile ?? '—'}（${row.peerCount} 家）`}
          >
            <span className="absolute left-0 top-1 w-[86px] shrink-0 text-[12px] text-[var(--color-fg-2)]">{row.label}</span>
            <span className="absolute left-[92px] right-[52px] top-[11px] h-[4px] rounded-[3px] bg-[var(--color-border)]" />
            {row.median !== null ? (
              <span
                className="absolute top-[2px] h-[22px] w-[2px] bg-[var(--color-fg-3)]"
                style={{ left: `calc(92px + (100% - 144px) * ${px(row.median)} / 100)` }}
                title={`同行中位 ${fmt(row.median)}`}
              />
            ) : null}
            {row.subject !== null ? (
              <span
                className="absolute top-[5px] h-[16px] w-[16px] rounded-full border-[3px] border-[var(--color-accent)] bg-[var(--color-elev)]"
                style={{ left: `calc(92px + (100% - 144px) * ${px(row.subject)} / 100 - 8px)` }}
                title={`本公司 ${fmt(row.subject)}`}
              />
            ) : null}
            <span
              className="absolute right-0 top-[3px] font-mono text-[11.5px]"
              style={{ color: pctColor(row.rankPercentile) }}
            >
              P{row.rankPercentile !== null ? Math.round(row.rankPercentile) : '—'}
            </span>
          </div>
        );
      })}
      <div className="mt-2 flex flex-wrap gap-x-4 text-[11px] text-[var(--color-fg-3)]">
        <span className="inline-flex items-center gap-1.5">
          <i className="block h-[11px] w-[11px] rounded-full border-[3px] border-[var(--color-accent)]" aria-hidden />
          本公司
        </span>
        <span className="inline-flex items-center gap-1.5">
          <i className="block h-[12px] w-[2px] bg-[var(--color-fg-3)]" aria-hidden />
          同行中位数
        </span>
        <span>分位 P≥70 偏贵 / P≤30 偏低</span>
      </div>
    </div>
  );
}
