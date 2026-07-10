'use client';

import { type AnalysisDto } from '@/lib/api';
import { Button, Dialog } from '@/components/ui';
import { ANALYSIS_TYPES } from '../stock-page-ui';

export function ConflictDialog({
  open,
  onClose,
  ongoing,
  onView,
  onCancelAndNew,
}: {
  open: boolean;
  onClose: () => void;
  ongoing: AnalysisDto;
  onView: () => void;
  onCancelAndNew: () => void;
}) {
  const typeLabel =
    ANALYSIS_TYPES.find((t) => t.value === ongoing.analysisType)?.label ??
    ongoing.analysisType;
  const startedAt = new Date(ongoing.createdAt).getTime();
  const ageSec = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  const ageLabel =
    ageSec < 60
      ? `${ageSec} 秒前`
      : ageSec < 3600
        ? `${Math.floor(ageSec / 60)} 分钟前`
        : `${Math.floor(ageSec / 3600)} 小时前`;

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => !v && onClose()}
      ariaLabel="已有分析在进行中"
      titleSlot="已有分析在进行中"
      size="md"
    >
      <div className="px-5 py-4">
        <p className="m-0 text-[13.5px] leading-[1.7] text-[var(--color-fg)]">
          一份「{typeLabel}」分析已在 {ageLabel} 启动，目前还在跑。同一只股票同时只能有一份分析进行。
        </p>
        <div
          className={
            'mt-3 flex items-center justify-between rounded-[var(--radius-btn)] ' +
            'bg-[var(--color-surface-2)] px-3 py-2 font-mono text-[11.5px]'
          }
        >
          <span className="text-[var(--color-fg-3)]">运行中 · 已 {ageLabel.replace('前', '')}</span>
          <span className="text-[var(--color-accent-600)] font-medium">
            {ongoing.aiModel ?? ongoing.aiProvider ?? '—'}
          </span>
        </div>
        <p className="mt-4 mb-0 text-[12.5px] leading-[1.65] text-[var(--color-fg-2)]">
          你想要：
        </p>
      </div>
      <div
        className={
          'flex flex-wrap items-center justify-end gap-2 border-t ' +
          'border-[var(--color-border-soft)] px-5 py-3'
        }
      >
        <Button size="sm" onClick={onClose}>
          关闭
        </Button>
        <Button
          size="sm"
          onClick={onCancelAndNew}
          className="border-[var(--color-danger-line)] text-[var(--color-danger)] hover:bg-[var(--color-danger-soft)]"
        >
          取消并新建
        </Button>
        <Button size="sm" variant="primary" onClick={onView}>
          查看进度
        </Button>
      </div>
    </Dialog>
  );
}

export function SwitchedNotice({
  ongoing,
  onCancelAndNew,
  onDismiss,
}: {
  ongoing: AnalysisDto;
  onCancelAndNew: () => void;
  onDismiss: () => void;
}) {
  const startedAt = new Date(ongoing.createdAt).getTime();
  const ageSec = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  const ageLabel =
    ageSec < 60
      ? `${ageSec} 秒前`
      : ageSec < 3600
        ? `${Math.floor(ageSec / 60)} 分钟前`
        : `${Math.floor(ageSec / 3600)} 小时前`;

  return (
    <div
      role="status"
      className={
        'mb-3 flex flex-wrap items-center gap-3 rounded-[var(--radius-btn)] ' +
        'border border-[var(--color-accent-line)] bg-[var(--color-accent-soft)] ' +
        'px-3.5 py-2 text-[12.5px] text-[var(--color-accent-600)]'
      }
    >
      <span className="stream-dot" aria-hidden />
      <span>
        已切换到正在进行的分析（启动于 {ageLabel}）。
      </span>
      <span className="ml-auto inline-flex gap-2">
        <Button
          size="sm"
          onClick={onCancelAndNew}
          className="border-[var(--color-danger-line)] text-[var(--color-danger)] hover:bg-[var(--color-danger-soft)]"
        >
          取消并新建
        </Button>
        <button
          type="button"
          onClick={onDismiss}
          className="text-[12px] text-[var(--color-accent-600)] hover:text-[var(--color-fg)] underline-offset-2 hover:underline"
        >
          关闭提示
        </button>
      </span>
    </div>
  );
}
