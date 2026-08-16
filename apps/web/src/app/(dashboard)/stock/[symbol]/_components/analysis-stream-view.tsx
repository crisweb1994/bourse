'use client';

import { useEffect, useRef } from 'react';
import { AlertCircle, Clock, Loader2, MessageSquareText, RotateCcw, Sparkles, Square } from 'lucide-react';
import type { AnalysisHistoryItemDto } from '@/lib/api';
import type { useAnalysisStream } from '@/hooks/use-analysis-stream';
import type { SectionData } from '@/hooks/analysis-stream-state';
import { MarkdownRenderer } from '@/components/shared/markdown-renderer';
import { cleanAnalysisMarkdown } from '@/components/analysis/analysis-markdown';
import { ConclusionBanner } from '@/components/analysis/conclusion-banner';
import { LeftSectionNav, type NavItem } from '@/components/analysis/left-section-nav';
import { ScrollSection } from '@/components/analysis/scroll-section';
import { ReportActionsBar } from '@/components/analysis/report-actions-bar';
import { DataQualityNotice } from '@/components/analysis/data-quality-notice';
import { useEvidence } from '@/components/charts/use-evidence';
import { SignalMatrix } from '@/components/charts/primitives/signal-matrix';
import { ChartFrame } from '@/components/charts/chart-frame';
import { CnMarketPanel } from '@/components/charts/cn-market-panel';
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
  // A replayed terminal analysis can briefly have an idle/streaming client
  // state while its metadata is loading. Use both sources so old snapshots
  // still get the rerun affordance and live evidence races can self-heal.
  const isTerminal =
    stream.status === 'completed' ||
    stream.status === 'error' ||
    stream.status === 'cancelled' ||
    currentAnalysisMeta?.status === 'COMPLETED' ||
    currentAnalysisMeta?.status === 'PARTIAL_FAILED' ||
    currentAnalysisMeta?.status === 'FAILED' ||
    currentAnalysisMeta?.status === 'CANCELLED';
  // Visualization §六 (P6): mount-fetch keyed by analysis id; SSE events are
  // only a refresh signal, never the sole trigger.
  const evidence = useEvidence(currentAnalysisMeta?.id ?? null);
  const evidenceReason = evidence.status === 'unavailable' ? evidence.reason : undefined;
  const lastEvidenceVersion = useRef(0);
  useEffect(() => {
    lastEvidenceVersion.current = 0;
  }, [currentAnalysisMeta?.id]);

  // 新建分析时快照尚未持久化，首次 evidence 请求会拿到
  // available:false（terminal）。每个 evidence_pack_ready 都递增
  // evidenceVersion，触发一次重取；图表在直播中自动出现，无需刷新页面。
  useEffect(() => {
    if (stream.evidenceVersion <= lastEvidenceVersion.current) return;
    lastEvidenceVersion.current = stream.evidenceVersion;
    // Only a terminal analysis with no snapshot is final. A live analysis can
    // briefly return `no_snapshot` while persistence catches up, so the next
    // evidence event must still be allowed to refresh it.
    if (isTerminal && evidence.status === 'unavailable' && evidenceReason === 'no_snapshot') return;
    evidence.refetch();
  }, [stream.evidenceVersion, evidence.status, evidenceReason, evidence.refetch, isTerminal]);

  return (
    <div className="space-y-4">
      {showMetaBar && currentAnalysisMeta && (
        <div className="rounded-[var(--radius-btn)] border border-[var(--color-border-soft)] bg-[var(--color-bg-elev)]">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 px-4 py-2.5 text-[12px] text-[var(--color-fg-2)]">
            <Pill variant="flat">{MODE_LABELS[currentAnalysisMeta.mode]} · {FOCUS_WINDOW_LABELS[currentAnalysisMeta.focusWindow]}</Pill>
            <span className="inline-flex items-center gap-1 font-mono"><Clock className="h-3 w-3" strokeWidth={1.5} />{formatAnalysisTime(currentAnalysisMeta.createdAt)}</span>
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

      {/* C6 · 五模块信号矩阵（方向 A 图形化；维度独立，不合成总分 V2） */}
      {currentAnalysisMeta && sectionList.length > 0 ? (
        <ChartFrame
          title="模块信号矩阵"
          status="ready"
          // C6 combines independent module outputs; capturedAt is fetch time,
          // not a data date, so do not present it as dataAsOf (F11).
          asOf={null}
          ariaSummary="五个研究模块各自的方向评估、置信度与一句话结论，附分歧度汇总"
        >
          <SignalMatrix
            rows={sectionList.map((section) => ({
              type: section.type,
              assessment: section.structuredJson?.assessment as string | undefined,
              confidence: section.structuredJson?.confidence as string | undefined,
              summary: section.structuredJson?.summary as string | undefined,
              status: section.status,
              coverage: (evidence.status === 'ready'
                ? (evidence.data.researchCoverage as {
                    dimensions?: Record<string, {
                      status?: string;
                      confidenceCap?: string;
                      missingCriticalFacts?: string[];
                      blockedClaims?: string[];
                    }>;
                  } | null | undefined)?.dimensions?.[section.type]
                : undefined),
            }))}
            onJump={(type) => onNavClick(`section-${type}`)}
          />
        </ChartFrame>
      ) : null}

      {stream.status === 'streaming' && (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={() => void onStop()}><Square className="h-3 w-3" strokeWidth={1.5} />取消研究</Button>
          {stuckSuspected && <span className="inline-flex items-center gap-2 rounded-[var(--radius-btn)] border border-[var(--color-warn-line)] bg-[var(--color-warn-soft)] px-3 py-1.5 text-[12px] text-[var(--color-warn)]"><AlertCircle className="h-3.5 w-3.5" strokeWidth={1.5} />长时间没有进度<Button size="sm" onClick={() => void onAbortStuck()} disabled={aborting}>{aborting ? <Loader2 className="h-3 w-3 animate-spin" strokeWidth={1.5} /> : <RotateCcw className="h-3 w-3" strokeWidth={1.5} />}取消</Button></span>}
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-[200px_minmax(0,1fr)]">
        <LeftSectionNav items={navItems} activeId={effectiveActive} onSelect={onNavClick} />
        <div className="min-w-0 space-y-6">
          {sectionList.map((section) => <ScrollSection key={section.type} section={section} onRetry={onRetry} showCitations onAsk={onAskAnalysis} evidence={evidence} market={market} focusWindow={currentAnalysisMeta?.focusWindow} analysisTerminal={isTerminal} onEvidenceRetry={evidence.refetch} onRerun={onRerun} onJump={(type) => onNavClick(`section-${type}`)} />)}
          {evidence.status === 'ready' ? (
            <CnMarketPanel
              market={market}
              northbound={evidence.data?.chartFacts.northbound}
              northboundHoldings={evidence.data?.chartFacts.northboundHoldings}
              unlockCalendar={evidence.data?.chartFacts.unlockCalendar}
              northboundTier={evidence.data?.provenance.northbound}
              unlockTier={evidence.data?.provenance.unlockCalendar}
              degraded={evidence.data?.degraded}
            />
          ) : null}
          {stream.summaryMarkdown && (
            <section id="section-SUMMARY" className="scroll-mt-4">
              <Card>
                <div className="flex items-center gap-2 border-b border-[var(--color-border-soft)] px-5 py-3"><SectionTag>综合结论</SectionTag>{!isTerminal && <span className="flex items-center gap-1 font-mono text-[10.5px] text-[var(--color-fg-3)]"><span className="stream-dot" />生成中</span>}</div>
                <div className="px-6 py-5"><MarkdownRenderer content={cleanAnalysisMarkdown(stream.summaryMarkdown)} /></div>
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
