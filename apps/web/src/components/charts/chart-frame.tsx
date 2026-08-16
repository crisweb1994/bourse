'use client';

/**
 * ChartFrame — the single shell every chart renders inside (visualization
 * technical design §六). Owns the four states (V3/V5 enforcement point),
 * dataAsOf / sourceTier badges, a11y role split (P7: figure+group outside,
 * role="img" only on the plot), and print behavior (V7).
 *
 * Business chart components are NOT allowed to draw their own empty states.
 */

import type { ReactNode } from 'react';
import { RefreshCcw, RotateCcw } from 'lucide-react';

export type ChartTier = 'A' | 'B' | 'C' | 'D' | 'E';

export interface ChartFrameProps {
  title: string;
  status: 'loading' | 'ready' | 'empty' | 'degraded';
  /** Data date from the owning data block (F11: never invented top-level). */
  asOf?: string | null;
  sourceTier?: ChartTier | null;
  emptyReason?: { code?: string; message: string };
  degradedNote?: string;
  /** Optional header actions such as "询问此图". */
  actions?: ReactNode;
  /** Retry a transient evidence request failure. */
  onRetry?: () => void;
  /** Start a new analysis when this chart belongs to an old snapshot. */
  onRerun?: () => void;
  /** Text summary for screen readers (P7) — the plot itself is role="img". */
  ariaSummary?: string;
  className?: string;
  children?: ReactNode;
}

const TIER_CLASS: Record<ChartTier, string> = {
  A: 'text-[var(--color-signal-bullish)] border-[var(--color-signal-bullish)]',
  B: 'text-[var(--color-accent)] border-[var(--color-accent)]',
  C: 'text-[var(--color-warn)] border-[var(--color-warn)]',
  D: 'text-[var(--color-fg-3)] border-[var(--color-fg-3)]',
  E: 'text-[var(--color-fg-3)] border-[var(--color-fg-3)]',
};

export function ChartFrame({
  title,
  status,
  asOf,
  sourceTier,
  emptyReason,
  degradedNote,
  actions,
  onRetry,
  onRerun,
  ariaSummary,
  className,
  children,
}: ChartFrameProps) {
  return (
    <figure
      role="group"
      aria-label={title}
      className={`chart-frame rounded-[var(--radius-card)] border border-[var(--color-border-soft)] bg-[var(--color-elev)] px-4 py-3.5 ${className ?? ''}`}
    >
      <div className="mb-2.5 flex flex-wrap items-center gap-2">
        <span className="text-[12.5px] font-semibold">{title}</span>
        <span className="flex-1" />
        {actions}
        {asOf ? (
          <span className="font-mono text-[10.5px] text-[var(--color-fg-3)]">
            dataAsOf {asOf.slice(0, 10)}
          </span>
        ) : null}
        {sourceTier ? (
          <span
            className={`rounded-[4px] border px-1.5 py-px font-mono text-[10px] leading-[1.5] ${TIER_CLASS[sourceTier]}`}
            title={`来源等级 ${sourceTier}`}
          >
            {sourceTier}
          </span>
        ) : null}
      </div>

      {status === 'loading' ? (
        <div className="flex h-[120px] items-center justify-center rounded-[6px] bg-[var(--color-elev-2)]">
          <span className="text-[12px] text-[var(--color-fg-3)]">图表数据加载中…</span>
        </div>
      ) : null}

      {status === 'empty' ? (
        <div className="flex h-[120px] flex-col items-center justify-center gap-1 rounded-[6px] border border-dashed border-[var(--color-border)] bg-[var(--color-elev-2)] text-center">
          <span className="text-[12.5px] text-[var(--color-fg-2)]">
            {emptyReason?.message ?? '暂无图表数据'}
          </span>
          {emptyReason?.code ? (
            <span className="font-mono text-[10.5px] text-[var(--color-fg-3)]">
              {emptyReason.code}
            </span>
          ) : null}
          {(onRetry || onRerun) ? (
            <div className="mt-1.5 flex flex-wrap justify-center gap-2">
              {onRetry ? (
                <button
                  type="button"
                  onClick={onRetry}
                  className="inline-flex items-center gap-1 rounded-[5px] border border-[var(--color-border)] px-2 py-1 text-[11px] text-[var(--color-fg-2)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
                >
                  <RotateCcw className="h-3 w-3" aria-hidden />
                  重试
                </button>
              ) : null}
              {onRerun ? (
                <button
                  type="button"
                  onClick={onRerun}
                  className="inline-flex items-center gap-1 rounded-[5px] border border-[var(--color-accent)] px-2 py-1 text-[11px] text-[var(--color-accent)] hover:bg-[var(--color-accent-soft)]"
                >
                  <RefreshCcw className="h-3 w-3" aria-hidden />
                  重新分析
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      {status === 'degraded' || (status === 'ready' && degradedNote) ? (
        <>
          {degradedNote ? (
            <p className="m-0 mb-2 rounded-[6px] border border-[var(--color-warn)] bg-[var(--color-warn-soft)] px-2.5 py-1.5 text-[11.5px] text-[var(--color-warn)]">
              {degradedNote}
            </p>
          ) : null}
          {children}
        </>
      ) : null}

      {status === 'ready' && !degradedNote ? children : null}

      {ariaSummary ? (
        <figcaption className="sr-only">{ariaSummary}</figcaption>
      ) : null}
    </figure>
  );
}
