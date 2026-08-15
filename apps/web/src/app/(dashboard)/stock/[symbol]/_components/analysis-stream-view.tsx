'use client';

import { AlertCircle, Bot, Clock, Loader2, MessageSquareText, RotateCcw, Sparkles, Square } from 'lucide-react';
import type { AnalysisHistoryItemDto } from '@/lib/api';
import type { useAnalysisStream } from '@/hooks/use-analysis-stream';
import type { SectionData } from '@/hooks/analysis-stream-state';
import { MarkdownRenderer } from '@/components/shared/markdown-renderer';
import { ConclusionBanner } from '@/components/analysis/conclusion-banner';
import { LeftSectionNav, type NavItem } from '@/components/analysis/left-section-nav';
import { ScrollSection } from '@/components/analysis/scroll-section';
import { ReportActionsBar } from '@/components/analysis/report-actions-bar';
import { DataQualityNotice } from '@/components/analysis/data-quality-notice';
import { Button, Card, Pill, SectionTag } from '@/components/ui';
import { FOCUS_WINDOW_LABELS, MODE_LABELS, SECTION_LABELS } from '@/lib/constants';
import { formatAnalysisTime } from '../stock-page-ui';

type AnalysisStream = ReturnType<typeof useAnalysisStream>;

interface Props {
  stream: AnalysisStream;
  currentAnalysisMeta: AnalysisHistoryItemDto | null;
  sectionList: SectionData[];
  navItems: NavItem[];
  effectiveActive: string | null;
  failedSections: SectionData[];
  stuckSuspected: boolean;
  aborting: boolean;
  showMetaBar: boolean;
  symbol: string | null;
  market: string;
  watchlistItemId: string | null;
  watchlistBusy: boolean;
  onNavClick: (id: string) => void;
  onOpenAnalysisForm: () => void;
  onStop: () => void | Promise<void>;
  onAbortStuck: () => void | Promise<void>;
  onRetry: () => void | Promise<void>;
  onAddToWatchlist: () => void | Promise<void>;
  onRerun: () => void | Promise<void>;
  onAskAnalysis: (sectionType?: string) => void;
}

/** Retrying reruns genuinely FAILED sections; a SKIPPED section is a
 * deterministic outcome of the immutable snapshot and needs a new run. */
function hasRetryableSections(meta: AnalysisHistoryItemDto | null): boolean {
  const hasFailedSection = (meta?.sections ?? []).some((section) => section.status === 'FAILED');
  const summaryFailed =
    meta?.status === 'PARTIAL_FAILED' &&
    !meta.summaryMarkdown &&
    !meta.summaryJson;
  return hasFailedSection || summaryFailed;
}

export function AnalysisStreamView({
  stream,
  currentAnalysisMeta,
  sectionList,
  navItems,
  effectiveActive,
  failedSections,
  stuckSuspected,
  aborting,
  showMetaBar,
  symbol,
  market,
  watchlistItemId,
  watchlistBusy,
  onNavClick,
  onOpenAnalysisForm,
  onStop,
  onAbortStuck,
  onRetry,
  onAddToWatchlist,
  onRerun,
  onAskAnalysis,
}: Props) {
  const summary = stream.summaryJson;
  const isTerminal = stream.status === 'completed' || stream.status === 'error' || stream.status === 'cancelled';
  return (
    <div className="space-y-4">
      {showMetaBar && currentAnalysisMeta && (
        <div className="rounded-[var(--radius-btn)] border border-[var(--color-border-soft)] bg-[var(--color-bg-elev)]">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 px-4 py-2.5 text-[12px] text-[var(--color-fg-2)]">
            <Pill variant="flat">{MODE_LABELS[currentAnalysisMeta.mode]} · {FOCUS_WINDOW_LABELS[currentAnalysisMeta.focusWindow]}</Pill>
            <span className="inline-flex items-center gap-1 font-mono"><Clock className="h-3 w-3" strokeWidth={1.5} />{formatAnalysisTime(currentAnalysisMeta.createdAt)}</span>
            {currentAnalysisMeta.aiModel && <span className="inline-flex items-center gap-1 font-mono"><Bot className="h-3 w-3" strokeWidth={1.5} />{currentAnalysisMeta.aiModel}</span>}
            <Button variant="primary" size="sm" className="ml-auto" onClick={onOpenAnalysisForm} disabled={stream.status === 'streaming'}><Sparkles className="h-3 w-3" strokeWidth={1.5} />新研究</Button>
          </div>
          {currentAnalysisMeta.question && <div className="flex items-start gap-2 border-t border-[var(--color-border-soft)] px-4 py-2.5 text-[12.5px] leading-[1.55]"><MessageSquareText className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--color-accent)]" strokeWidth={1.5} /><span className="shrink-0 text-[var(--color-fg-2)]">研究焦点</span><p className="m-0 min-w-0 flex-1 text-[var(--color-fg)]">{currentAnalysisMeta.question}</p></div>}
        </div>
      )}

      {(stream.status === 'error' || failedSections.length > 0) && (
        <Card className="border-[var(--color-danger-line)] bg-[var(--color-danger-soft)]">
          <div className="flex items-start gap-3 p-4">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-danger)]" strokeWidth={1.5} />
            <div className="min-w-0 flex-1">
              <h3 className="m-0 text-[13px] font-medium text-[var(--color-danger)]">{stream.terminalStatus === 'PARTIAL_FAILED' ? '研究部分完成' : stream.status === 'error' ? '研究失败' : `${failedSections.length} 个模块未完成`}</h3>
              <p className="m-0 mt-1.5 text-[12.5px] leading-[1.6] text-[var(--color-fg)]">已完成的模块仍然可用，可以统一重试失败部分。</p>
              {failedSections.length > 0 && <p className="mt-2 text-[12px] text-[var(--color-fg-2)]">未完成：{failedSections.map((section) => SECTION_LABELS[section.type]).join('、')}</p>}
            </div>
              {(currentAnalysisMeta?.status === 'FAILED' || currentAnalysisMeta?.status === 'PARTIAL_FAILED') && hasRetryableSections(currentAnalysisMeta) ? <Button size="sm" onClick={() => void onRetry()}><RotateCcw className="h-3 w-3" strokeWidth={1.5} />重试</Button> : null}
          </div>
        </Card>
      )}

      <DataQualityNotice degraded={stream.degraded} />

      {summary && <ConclusionBanner signal={summary.signal} confidence={summary.confidence} headline={summary.headline} dataAsOf={summary.dataAsOf} />}

      {stream.status === 'streaming' && (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={() => void onStop()}><Square className="h-3 w-3" strokeWidth={1.5} />取消研究</Button>
          {stream.usage && <span className="font-mono text-[10.5px] text-[var(--color-fg-3)]">已处理 {stream.usage.totalTokens.toLocaleString()} tokens</span>}
          {stuckSuspected && <span className="inline-flex items-center gap-2 rounded-[var(--radius-btn)] border border-[var(--color-warn-line)] bg-[var(--color-warn-soft)] px-3 py-1.5 text-[12px] text-[var(--color-warn)]"><AlertCircle className="h-3.5 w-3.5" strokeWidth={1.5} />长时间没有进度<Button size="sm" onClick={() => void onAbortStuck()} disabled={aborting}>{aborting ? <Loader2 className="h-3 w-3 animate-spin" strokeWidth={1.5} /> : <RotateCcw className="h-3 w-3" strokeWidth={1.5} />}取消</Button></span>}
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-[200px_minmax(0,1fr)]">
        <LeftSectionNav items={navItems} activeId={effectiveActive} onSelect={onNavClick} />
        <div className="min-w-0 space-y-6">
          {sectionList.map((section) => <ScrollSection key={section.type} section={section} onRetry={onRetry} showCitations onAsk={onAskAnalysis} />)}
          {stream.summaryMarkdown && (
            <section id="section-SUMMARY" className="scroll-mt-4">
              <Card>
                <div className="flex items-center gap-2 border-b border-[var(--color-border-soft)] px-5 py-3"><SectionTag>综合结论</SectionTag>{!isTerminal && <span className="flex items-center gap-1 font-mono text-[10.5px] text-[var(--color-fg-3)]"><span className="stream-dot" />生成中</span>}</div>
                <div className="px-6 py-5"><MarkdownRenderer content={stream.summaryMarkdown} /></div>
              </Card>
            </section>
          )}
          {stream.status === 'cancelled' && <Card><div className="p-4 text-[13px] text-[var(--color-fg-2)]">本次研究已取消，已生成的模块内容保留在报告中。</div></Card>}
          {currentAnalysisMeta && symbol && (
            <ReportActionsBar
              sections={sectionList}
              summaryMarkdown={stream.summaryMarkdown}
              symbol={symbol}
              market={market}
              generatedAt={currentAnalysisMeta.createdAt}
              signal={summary?.signal ?? currentAnalysisMeta.overallSignal}
              confidence={summary?.confidence ?? currentAnalysisMeta.overallConfidence}
              showAddToWatchlist={!watchlistItemId}
              watchlistBusy={watchlistBusy}
              onAddToWatchlist={onAddToWatchlist}
              onRerun={onRerun}
              onAskAnalysis={() => onAskAnalysis()}
            />
          )}
        </div>
      </div>
    </div>
  );
}
