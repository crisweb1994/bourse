'use client';

import type { ComponentProps } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  Bot,
  Clock,
  Loader2,
  MessageSquareText,
  RotateCcw,
  Sparkles,
  Square,
} from 'lucide-react';
import type { AnalysisHistoryItemDto } from '@/lib/api';
import type {
  SectionData,
  useAnalysisStream,
} from '@/hooks/use-analysis-stream';
import { MarkdownRenderer } from '@/components/shared/markdown-renderer';
import { ConclusionBanner } from '@/components/analysis/conclusion-banner';
import {
  LeftSectionNav,
  type NavItem,
} from '@/components/analysis/left-section-nav';
import { ScrollSection } from '@/components/analysis/scroll-section';
import { RightInsightsPanel } from '@/components/analysis/right-insights-panel';
import { ReportActionsBar } from '@/components/analysis/report-actions-bar';
import { DataQualityNotice } from '@/components/analysis/data-quality-notice';
import { Button, Card, Pill, SectionTag } from '@/components/ui';
import { ANALYSIS_TYPE_LABELS as SECTION_LABELS } from '@/lib/constants';
import { cn } from '@/lib/utils';
import {
  ANALYSIS_TYPES,
  formatAnalysisTime,
} from '../stock-page-ui';
import { ComprehensiveSummaryCard } from './comprehensive-summary-card';

type AnalysisStream = ReturnType<typeof useAnalysisStream>;
type RightInsightsSummary = ComponentProps<
  typeof RightInsightsPanel
>['summaryJson'];

interface AnalysisStreamViewProps {
  stream: AnalysisStream;
  currentAnalysisMeta: AnalysisHistoryItemDto | null;
  recentAnalyses: AnalysisHistoryItemDto[];
  sectionList: SectionData[];
  isMultiSection: boolean;
  navItems: NavItem[];
  effectiveActive: string | null;
  rightInsightsSummary: RightInsightsSummary;
  hasRightPanel: boolean;
  failedSections: SectionData[];
  stuckSuspected: boolean;
  aborting: boolean;
  showMetaBar: boolean;
  effectiveStockId: string | null;
  symbol: string | null;
  market: string;
  watchlistItemId: string | null;
  watchlistBusy: boolean;
  compareOpen: boolean;
  onNavClick: (id: string) => void;
  onOpenAnalysisForm: () => void;
  onAbortStuck: () => void | Promise<void>;
  onRetry: (sectionId: string) => void | Promise<void>;
  onAddToWatchlist: () => void | Promise<void>;
  onRerun: () => void | Promise<void>;
  onCompareOpenChange: (open: boolean) => void;
}

export function AnalysisStreamView({
  stream,
  currentAnalysisMeta,
  recentAnalyses,
  sectionList,
  isMultiSection,
  navItems,
  effectiveActive,
  rightInsightsSummary,
  hasRightPanel,
  failedSections,
  stuckSuspected,
  aborting,
  showMetaBar,
  effectiveStockId,
  symbol,
  market,
  watchlistItemId,
  watchlistBusy,
  compareOpen,
  onNavClick,
  onOpenAnalysisForm,
  onAbortStuck,
  onRetry,
  onAddToWatchlist,
  onRerun,
  onCompareOpenChange,
}: AnalysisStreamViewProps) {
  return (
    <div className="space-y-4">
      {showMetaBar && currentAnalysisMeta && (
        <div className="rounded-[var(--radius-btn)] border border-[var(--color-border-soft)] bg-[var(--color-bg-elev)]">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 px-4 py-2.5 text-[12px] text-[var(--color-fg-2)]">
            <Pill variant="emerald">
              {ANALYSIS_TYPES.find(
                (t) => t.value === currentAnalysisMeta.analysisType,
              )?.label || currentAnalysisMeta.analysisType}
            </Pill>
            <span className="inline-flex items-center gap-1 font-mono">
              <Clock className="w-3 h-3" strokeWidth={1.5} />
              {formatAnalysisTime(
                currentAnalysisMeta.generatedAt || currentAnalysisMeta.createdAt,
              )}
            </span>
            {(currentAnalysisMeta.aiModel || currentAnalysisMeta.aiProvider) && (
              <span className="inline-flex items-center gap-1 font-mono">
                <Bot className="w-3 h-3" strokeWidth={1.5} />
                {currentAnalysisMeta.aiModel || currentAnalysisMeta.aiProvider}
              </span>
            )}
            <span className="ml-auto inline-flex items-center gap-2">
              <Button
                variant="primary"
                size="sm"
                onClick={onOpenAnalysisForm}
                disabled={stream.status === 'streaming'}
              >
                <Sparkles className="w-3 h-3" strokeWidth={1.5} />
                新分析
              </Button>
            </span>
          </div>
          {currentAnalysisMeta.question && (
            <div className="flex items-start gap-2 border-t border-[var(--color-border-soft)] px-4 py-2.5 text-[12.5px] leading-[1.55]">
              <MessageSquareText className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--color-accent)]" strokeWidth={1.5} />
              <span className="text-[var(--color-fg-2)]">研究焦点</span>
              <p className="m-0 min-w-0 flex-1 text-[var(--color-fg)]">
                {currentAnalysisMeta.question}
              </p>
            </div>
          )}
        </div>
      )}

      {(stream.status === 'error' || failedSections.length > 0) && (
        <Card
          className={
            'border-[var(--color-danger-line)] bg-[var(--color-danger-soft)]'
          }
        >
          <div className="flex items-start gap-3 p-4">
            <AlertCircle
              className="w-4 h-4 mt-0.5 shrink-0 text-[var(--color-danger)]"
              strokeWidth={1.5}
            />
            <div className="min-w-0 flex-1">
              <h3 className="text-[13px] font-medium text-[var(--color-danger)] m-0">
                {stream.status === 'error'
                  ? '分析失败'
                  : `${failedSections.length} 个维度未完成`}
              </h3>
              <p className="mt-1.5 text-[12.5px] leading-[1.6] text-[var(--color-fg)] m-0">
                {stream.status === 'error'
                  ? '分析过程出错，可能原因是 AI 服务临时不可用或网络中断；可重新发起分析。'
                  : '分析整体完成，但部分维度生成失败。可能原因是 AI 服务临时不可用或外部数据源响应超时；其余维度结论仍然有效。'}
              </p>
              {failedSections.length > 0 && (
                <p className="mt-2 text-[12px] text-[var(--color-fg-2)]">
                  失败维度：
                  {failedSections.map((s, i) => (
                    <span key={s.type}>
                      {i > 0 && '、'}
                      <button
                        onClick={() => onNavClick(`section-${s.type}`)}
                        className="font-medium underline hover:no-underline"
                      >
                        {SECTION_LABELS[s.type] || s.type}
                      </button>
                    </span>
                  ))}
                </p>
              )}
            </div>
            <Button size="sm" onClick={onOpenAnalysisForm}>
              重新分析
            </Button>
          </div>
        </Card>
      )}

      {stream.attachedElsewhere && (
        <div
          data-testid="attached-elsewhere-notice"
          className={
            'flex items-start gap-2.5 rounded-[var(--radius-btn)] border border-l-[3px] ' +
            'border-[var(--color-border)] border-l-[var(--color-warn)] ' +
            'bg-[var(--color-bg-elev)] px-3.5 py-2.5 text-[12.5px] leading-[1.55]'
          }
        >
          <AlertTriangle
            className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--color-warn)]"
            strokeWidth={1.5}
          />
          <div className="min-w-0 flex-1">
            <span className="font-medium text-[var(--color-fg)]">
              分析正在另一处运行
            </span>
            <span className="text-[var(--color-fg-2)]">
              {' '}
              · 当前页面会在分析完成后自动加载完整结果，期间无需操作。
            </span>
          </div>
        </div>
      )}

      <DataQualityNotice degraded={stream.degraded} />

      {stream.summaryJson && (
        <ConclusionBanner
          signal={stream.summaryJson.overallSignal}
          confidence={stream.summaryJson.overallConfidence}
          oneLiner={stream.summaryJson.oneLiner}
          dataAsOf={stream.summaryJson.dataAsOf}
          analysisType="COMPREHENSIVE"
        />
      )}
      {!isMultiSection && sectionList[0]?.structuredJson && (
        <ConclusionBanner
          signal={sectionList[0].structuredJson.conclusion?.signal}
          confidence={sectionList[0].structuredJson.conclusion?.confidence}
          oneLiner={sectionList[0].structuredJson.conclusion?.oneLiner}
          dataAsOf={sectionList[0].structuredJson.dataAsOf}
          analysisType={sectionList[0].type}
        />
      )}

      {stream.status === 'streaming' && (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={stream.stopStream}>
            <Square className="w-3 h-3" strokeWidth={1.5} />
            停止
          </Button>
          {stuckSuspected && (
            <span
              className={
                'inline-flex items-center gap-2 rounded-[var(--radius-btn)] ' +
                'border border-[var(--color-warn-line)] bg-[var(--color-warn-soft)] ' +
                'px-3 py-1.5 text-[12px] text-[var(--color-warn)]'
              }
            >
              <AlertCircle className="w-3.5 h-3.5" strokeWidth={1.5} />
              3 分钟无进度，可能卡住了
              <Button size="sm" onClick={onAbortStuck} disabled={aborting}>
                {aborting ? (
                  <Loader2 className="w-3 h-3 animate-spin" strokeWidth={1.5} />
                ) : (
                  <RotateCcw className="w-3 h-3" strokeWidth={1.5} />
                )}
                强制重置
              </Button>
            </span>
          )}
        </div>
      )}

      {isMultiSection && (
        <div
          className={cn(
            'grid gap-6',
            hasRightPanel
              ? 'lg:grid-cols-[200px_1fr_320px]'
              : 'lg:grid-cols-[200px_1fr]',
          )}
        >
          <div className="order-1 lg:order-1">
            <LeftSectionNav
              items={navItems}
              activeId={effectiveActive}
              onSelect={onNavClick}
            />
          </div>

          <div className="order-3 lg:order-2 min-w-0 space-y-6">
            {sectionList.map((sec) => (
              <ScrollSection
                key={sec.type}
                section={sec}
                onRetry={onRetry}
                showSideContent={false}
                showCitations={true}
              />
            ))}

            {stream.summaryMarkdown && (
              <section id="section-SUMMARY" className="scroll-mt-4">
                <Card>
                  <div className="flex items-center gap-2 border-b border-[var(--color-border-soft)] px-5 py-3">
                    <SectionTag>综合总览</SectionTag>
                    {stream.status === 'streaming' && (
                      <span className="flex items-center gap-1 font-mono text-[10.5px] text-[var(--color-fg-3)] uppercase tracking-[0.04em]">
                        <span className="stream-dot" />
                        生成中
                      </span>
                    )}
                  </div>
                  <div className="px-6 py-5">
                    <MarkdownRenderer content={stream.summaryMarkdown} />
                    {stream.summaryJson && (
                      <div className="mt-6">
                        <ComprehensiveSummaryCard data={stream.summaryJson} />
                      </div>
                    )}
                  </div>
                </Card>
              </section>
            )}
          </div>

          {hasRightPanel && (
            <div className="order-2 lg:order-3">
              <RightInsightsPanel summaryJson={rightInsightsSummary} />
            </div>
          )}
        </div>
      )}

      {!isMultiSection && sectionList.length === 1 && (
        <ScrollSection
          section={sectionList[0]}
          onRetry={onRetry}
          showSideContent={true}
        />
      )}

      {stream.status === 'streaming' && sectionList.length === 0 && (
        <Card>
          <div className="flex items-center gap-2 px-5 py-4 text-[13px] text-[var(--color-fg-2)]">
            <span className="stream-dot" />
            正在初始化分析…
          </div>
        </Card>
      )}

      {stream.status === 'completed' &&
        sectionList.some((s) => s.status === 'failed') && (
          <p className="text-[11.5px] text-[var(--color-fg-2)]">
            部分维度分析失败，可在对应维度点击重试
          </p>
        )}

      {stream.status === 'completed' && effectiveStockId && (
        <ReportActionsBar
          sections={sectionList}
          summaryMarkdown={stream.summaryMarkdown}
          symbol={symbol ?? ''}
          market={market}
          generatedAt={
            currentAnalysisMeta?.generatedAt ??
            currentAnalysisMeta?.createdAt ??
            null
          }
          signal={stream.summaryJson?.overallSignal ?? null}
          confidence={stream.summaryJson?.overallConfidence ?? null}
          showAddToWatchlist={!watchlistItemId}
          watchlistBusy={watchlistBusy}
          onAddToWatchlist={!watchlistItemId ? onAddToWatchlist : undefined}
          onRerun={onRerun}
          onCompareWithLast={
            recentAnalyses.filter(
              (a) =>
                a.id !== currentAnalysisMeta?.id &&
                a.analysisType === currentAnalysisMeta?.analysisType &&
                a.status === 'COMPLETED',
            ).length > 0
              ? () => onCompareOpenChange(true)
              : undefined
          }
          comparing={compareOpen}
        />
      )}
    </div>
  );
}
