'use client';

/**
 * 数据质量 notice — a single user-readable line under the analysis header.
 *
 * Shows only when a `degraded` event arrived (a realtime data source fell
 * back to web search); renders nothing on a clean run.
 *
 * plan-v2 Wave 3.2 removed the planner/slot research SSE events, so the old
 * full/partial confidence levels + `?dev=1` slot drawer are gone — this is
 * now degraded-or-nothing.
 */
import { AlertCircle } from 'lucide-react';
import type { DegradedInfo } from '@/hooks/use-analysis-stream';

export function ResearchProgressStrip({
  degraded,
}: {
  degraded?: DegradedInfo | null;
}) {
  if (!degraded) return null;

  const failed = degraded.failedTools?.length
    ? `（${degraded.failedTools.join(', ')}）`
    : '';
  const message = `部分实时数据接口${failed}不可用，已使用网页搜索补全。`;

  return (
    <div data-testid="data-quality-notice">
      <div
        className={
          'flex items-start gap-2.5 rounded-[var(--radius-card)] border ' +
          'border-l-[3px] px-3.5 py-2.5 text-[12.5px] leading-[1.55] ' +
          'bg-[var(--color-bg-elev)] ' +
          'border-[var(--color-border)] border-l-[var(--color-danger)]'
        }
      >
        <AlertCircle
          className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--color-danger)]"
          strokeWidth={1.5}
        />
        <div className="min-w-0 flex-1">
          <span className="font-medium">数据源降级</span>
          <span className="text-[var(--color-fg-2)]"> · {message}</span>
        </div>
      </div>
    </div>
  );
}
