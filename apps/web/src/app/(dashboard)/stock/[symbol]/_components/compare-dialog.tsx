'use client';

import { useState, useEffect } from 'react';
import { getAnalysis, type AnalysisDto } from '@/lib/api';
import { Button, Dialog } from '@/components/ui';
import { cn } from '@/lib/utils';
import { formatAnalysisTime } from '../stock-page-ui';
import { SIGNAL_LABELS, CONFIDENCE_LABELS } from '@/lib/constants';

// ============================================================
// CompareDialog — S4+ · 上一次 vs 这次 diff
// ============================================================
// Reuses the user's recent-analyses list: find the most recent COMPLETED
// analysis of the same type (other than `current`) and show side-by-side
// signal / confidence / oneLiner / bull case / bear case + biggest risk
// deltas. Detailed fields come from the previous run's `summaryJson`
// which we fetch lazily on open (the list endpoint omits it).

export function CompareDialog({
  open,
  onClose,
  current,
  currentSummary,
  recents,
}: {
  open: boolean;
  onClose: () => void;
  current: AnalysisDto;
  currentSummary: any;
  recents: AnalysisDto[];
}) {
  const prev = recents.find(
    (a) =>
      a.id !== current.id &&
      a.analysisType === current.analysisType &&
      a.status === 'COMPLETED',
  );
  const [prevDetail, setPrevDetail] = useState<AnalysisDto | null>(null);
  const [loadingPrev, setLoadingPrev] = useState(false);

  useEffect(() => {
    if (!open || !prev) return;
    let cancelled = false;
    setLoadingPrev(true);
    getAnalysis(prev.id)
      .then((d) => {
        if (!cancelled) setPrevDetail(d);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setLoadingPrev(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, prev]);

  if (!open) return null;

  const SIG = (s: string | null | undefined) =>
    SIGNAL_LABELS[s ?? ''] ?? s ?? '—';
  const CONF = (c: string | null | undefined) =>
    CONFIDENCE_LABELS[c ?? ''] ?? c ?? '—';

  const prevSummary = (prevDetail as any)?.summaryJson ?? null;

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => !v && onClose()}
      ariaLabel="对比上次分析"
      titleSlot={
        <div className="flex items-center justify-between gap-3">
          <span>对比上次分析</span>
          <span className="font-mono text-[10.5px] text-[var(--color-fg-3)]">
            {current.analysisType}
          </span>
        </div>
      }
      size="lg"
    >
      <div className="px-5 py-5">
        {!prev && (
          <p className="text-[13px] text-[var(--color-fg-2)] m-0">
            未找到可对比的上一份同类型分析。
          </p>
        )}
        {prev && (
          <>
            <div className="grid grid-cols-2 gap-4 mb-5 text-[11.5px] font-mono text-[var(--color-fg-3)]">
              <div>
                <div className="text-[var(--color-fg-2)]">本次</div>
                <div className="text-[var(--color-fg)] mt-0.5">
                  {formatAnalysisTime(current.generatedAt || current.createdAt)}
                </div>
              </div>
              <div>
                <div className="text-[var(--color-fg-2)]">上次</div>
                <div className="text-[var(--color-fg)] mt-0.5">
                  {formatAnalysisTime(prev.generatedAt || prev.createdAt)}
                </div>
              </div>
            </div>

            <DiffRow
              label="信号"
              cur={SIG(currentSummary?.overallSignal ?? current.overallSignal)}
              prev={SIG(prevSummary?.overallSignal ?? prev.overallSignal)}
            />
            <DiffRow
              label="置信度"
              cur={CONF(
                currentSummary?.overallConfidence ?? current.overallConfidence,
              )}
              prev={CONF(
                prevSummary?.overallConfidence ?? prev.overallConfidence,
              )}
            />

            {loadingPrev && (
              <p className="mt-4 text-[12px] text-[var(--color-fg-3)] font-mono">
                正在加载上次完整数据…
              </p>
            )}

            {!loadingPrev && (
              <>
                <DiffText
                  label="一句话结论"
                  cur={currentSummary?.oneLiner}
                  prev={prevSummary?.oneLiner}
                />
                <DiffList
                  label="看多理由"
                  cur={currentSummary?.bullCase}
                  prev={prevSummary?.bullCase}
                />
                <DiffList
                  label="看空理由"
                  cur={currentSummary?.bearCase}
                  prev={prevSummary?.bearCase}
                />
                <DiffText
                  label="最大风险"
                  cur={currentSummary?.biggestRisk}
                  prev={prevSummary?.biggestRisk}
                />
              </>
            )}
          </>
        )}

        <div className="mt-5 flex justify-end">
          <Button onClick={onClose}>关闭</Button>
        </div>
      </div>
    </Dialog>
  );
}

function DiffRow({
  label,
  cur,
  prev,
}: {
  label: string;
  cur: string;
  prev: string;
}) {
  const changed = cur !== prev;
  return (
    <div className="grid grid-cols-[80px_1fr_1fr] items-center gap-3 py-2 border-b border-[var(--color-border-soft)]">
      <span className="text-[11.5px] font-mono text-[var(--color-fg-3)] uppercase tracking-[0.04em]">
        {label}
      </span>
      <span
        className={cn(
          'text-[13px]',
          changed
            ? 'font-medium text-[var(--color-fg)]'
            : 'text-[var(--color-fg-2)]',
        )}
      >
        {cur}
      </span>
      <span
        className={cn(
          'text-[13px]',
          changed ? 'text-[var(--color-fg-3)] line-through' : 'text-[var(--color-fg-3)]',
        )}
      >
        {prev}
      </span>
    </div>
  );
}

function DiffText({
  label,
  cur,
  prev,
}: {
  label: string;
  cur?: string | null;
  prev?: string | null;
}) {
  if (!cur && !prev) return null;
  return (
    <div className="mt-4">
      <div className="mb-2 font-mono text-[10.5px] uppercase tracking-[0.06em] text-[var(--color-fg-3)]">
        {label}
      </div>
      <div className="grid grid-cols-2 gap-3 text-[12.5px] leading-[1.6]">
        <div className="rounded-[var(--radius-btn)] border border-[var(--color-border)] bg-[var(--color-bg-elev)] p-3">
          {cur ?? '—'}
        </div>
        <div className="rounded-[var(--radius-btn)] border border-[var(--color-border-soft)] bg-[var(--color-surface-2)] p-3 text-[var(--color-fg-2)]">
          {prev ?? '—'}
        </div>
      </div>
    </div>
  );
}

function DiffList({
  label,
  cur,
  prev,
}: {
  label: string;
  cur?: string[];
  prev?: string[];
}) {
  if (!cur?.length && !prev?.length) return null;
  const curSet = new Set(cur ?? []);
  const prevSet = new Set(prev ?? []);
  return (
    <div className="mt-4">
      <div className="mb-2 font-mono text-[10.5px] uppercase tracking-[0.06em] text-[var(--color-fg-3)]">
        {label}
      </div>
      <div className="grid grid-cols-2 gap-3 text-[12.5px] leading-[1.55]">
        <ul className="m-0 list-none rounded-[var(--radius-btn)] border border-[var(--color-border)] bg-[var(--color-bg-elev)] p-3 space-y-1">
          {(cur ?? []).map((c, i) => (
            <li
              key={i}
              className={cn(
                'flex gap-2',
                !prevSet.has(c) && 'font-medium text-[var(--color-accent-600)]',
              )}
            >
              <span className="opacity-70">+</span>
              <span>{c}</span>
            </li>
          ))}
        </ul>
        <ul className="m-0 list-none rounded-[var(--radius-btn)] border border-[var(--color-border-soft)] bg-[var(--color-surface-2)] p-3 space-y-1 text-[var(--color-fg-2)]">
          {(prev ?? []).map((c, i) => (
            <li
              key={i}
              className={cn(
                'flex gap-2',
                !curSet.has(c) && 'line-through text-[var(--color-fg-3)]',
              )}
            >
              <span className="opacity-70">·</span>
              <span>{c}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
