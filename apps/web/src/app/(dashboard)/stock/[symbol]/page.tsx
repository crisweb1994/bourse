'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { abortAnalysis } from '@/lib/api';
import { useAnalysisStream } from '@/hooks/use-analysis-stream';
import { useStuckWatchdog } from '@/hooks/use-stuck-watchdog';
import { StockHeader } from '@/components/stock/stock-header';
import { Card, toast } from '@/components/ui';
import { AnalysisDialogs } from './_components/analysis-dialogs';
import { AnalysisLauncher } from './_components/analysis-launcher';
import { AnalysisStreamView } from './_components/analysis-stream-view';
import { SwitchedNotice } from './_components/conflict-dialog';
import {
  StockPageBackButton,
  StockResolutionStatus,
} from './_components/stock-page-chrome';
import { useAnalysisLauncherState } from './use-analysis-launcher-state';
import { useAnalysisResultLayout } from './use-analysis-result-layout';
import { useStockPageParams } from './use-stock-page-params';
import { useStockAnalysisLifecycle } from './use-stock-analysis-lifecycle';
import { useStockResolution } from './use-stock-resolution';

export default function StockAnalysisPage({
  params,
}: {
  params: Promise<{ symbol: string }>;
}) {
  const router = useRouter();
  const { symbol, stockId, market, name, analysisId } =
    useStockPageParams(params);
  const {
    selectedType,
    setSelectedType,
    selectedSettingId,
    setSelectedSettingId,
    selectedModel,
    setSelectedModel,
    providerSettings,
  } = useAnalysisLauncherState();
  const [aborting, setAborting] = useState(false);

  const [showAnalysisForm, setShowAnalysisForm] = useState(false);

  const stream = useAnalysisStream();

  const {
    detail,
    resolvingStock,
    effectiveStockId,
    watchlistItemId,
    watchlistBusy,
    canAddToWatchlist,
    handleAddToWatchlist,
  } = useStockResolution({ symbol, market, name, stockId });

  // Single source of truth for the analysis lifecycle (load / create / switch /
  // conflict). Owns recentAnalyses / currentAnalysisMeta / checkingOngoing /
  // loading + the conflict state, drives stream attach + the form's default
  // type. See useStockAnalysisLifecycle.
  const lifecycle = useStockAnalysisLifecycle({
    stream,
    effectiveStockId,
    analysisId,
    symbol,
    router,
    setFormType: setSelectedType,
    closeForm: () => setShowAnalysisForm(false),
    formSettingId: selectedSettingId,
    formModel: selectedModel,
  });
  const {
    recentAnalyses,
    currentAnalysisMeta,
    checkingOngoing,
    loading,
    conflictAnalysis,
    autoSwitchedFrom,
  } = lifecycle;
  const handleStartAnalysis = () =>
    lifecycle.startAnalysis({
      type: selectedType,
      settingId: selectedSettingId || undefined,
      model: selectedModel || undefined,
    });
  const handleRerun = lifecycle.rerun;
  const handleRetry = lifecycle.retrySection;
  const handleViewOngoing = lifecycle.viewOngoing;
  const handleCancelAndNew = lifecycle.cancelAndNew;

  const exchange =
    currentAnalysisMeta?.stock.exchange ||
    detail?.stock?.exchange ||
    detail?.candidates?.[0]?.exchange ||
    '';

  // SSE freshness watchdog — surfaces a force-reset hint after 3min of no
  // progress (skips while attachedElsewhere). See useStuckWatchdog.
  const stuckSuspected = useStuckWatchdog(stream);

  const handleAbortStuck = async () => {
    if (!stream.analysisId) return;
    setAborting(true);
    try {
      await abortAnalysis(stream.analysisId);
      // stopStream flips status off 'streaming' → the watchdog auto-clears.
      stream.stopStream();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : '强制重置失败');
    } finally {
      setAborting(false);
    }
  };

  const resultLayout = useAnalysisResultLayout({
    stream,
    analysisType: currentAnalysisMeta?.analysisType,
  });
  const {
    sectionList,
    isMultiSection,
    navItems,
    effectiveActive,
    rightInsightsSummary,
    hasRightPanel,
    failedSections,
    handleNavClick,
  } = resultLayout;
  const [compareOpen, setCompareOpen] = useState(false);

  return (
    <>
      <StockPageBackButton router={router} />
      {autoSwitchedFrom && (
        <SwitchedNotice
          ongoing={autoSwitchedFrom}
          onCancelAndNew={lifecycle.cancelAutoSwitchedAndNew}
          onDismiss={lifecycle.dismissAutoSwitched}
        />
      )}

      {symbol && (
        <StockHeader
          symbol={symbol}
          market={market}
          exchange={exchange}
          name={name}
          stockId={effectiveStockId}
          inWatchlist={!!watchlistItemId}
          watchlistBusy={watchlistBusy}
          onToggleWatchlist={
            canAddToWatchlist ? handleAddToWatchlist : undefined
          }
          recentAnalyses={recentAnalyses}
          quote={detail?.quote ?? null}
          profile={detail?.profile ?? null}
        />
      )}

      <StockResolutionStatus
        requestedStockId={stockId}
        effectiveStockId={effectiveStockId}
        resolvingStock={resolvingStock}
        detail={detail}
        symbol={symbol ?? ''}
        watchlistBusy={watchlistBusy}
        onAddAndAnalyze={async () => {
          await handleAddToWatchlist();
          setShowAnalysisForm(true);
        }}
        onAddOnly={handleAddToWatchlist}
      />

      {/* Checking status */}
      {stream.status === 'idle' && checkingOngoing && (
        <Card className="mb-6">
          <div className="flex items-center gap-2 px-5 py-3.5 text-[13px] text-[var(--color-fg-2)]">
            <Loader2
              className="w-3.5 h-3.5 animate-spin"
              strokeWidth={1.5}
            />
            检查分析状态…
          </div>
        </Card>
      )}

      <AnalysisLauncher
        open={showAnalysisForm}
        onOpenChange={setShowAnalysisForm}
        selectedType={selectedType}
        setSelectedType={setSelectedType}
        providerSettings={providerSettings}
        selectedSettingId={selectedSettingId}
        setSelectedSettingId={setSelectedSettingId}
        selectedModel={selectedModel}
        setSelectedModel={setSelectedModel}
        loading={loading}
        stockId={effectiveStockId}
        stockLabel={name || symbol || ''}
        onStart={handleStartAnalysis}
        showEmptyState={
          stream.status === 'idle' &&
          !checkingOngoing &&
          !showAnalysisForm &&
          !!effectiveStockId
        }
      />
      {stream.status !== 'idle' && (
        <AnalysisStreamView
          stream={stream}
          currentAnalysisMeta={currentAnalysisMeta}
          recentAnalyses={recentAnalyses}
          sectionList={sectionList}
          isMultiSection={isMultiSection}
          navItems={navItems}
          effectiveActive={effectiveActive}
          rightInsightsSummary={rightInsightsSummary}
          hasRightPanel={hasRightPanel}
          failedSections={failedSections}
          stuckSuspected={stuckSuspected}
          aborting={aborting}
          showMetaBar={!showAnalysisForm}
          effectiveStockId={effectiveStockId}
          symbol={symbol}
          market={market}
          watchlistItemId={watchlistItemId}
          watchlistBusy={watchlistBusy}
          compareOpen={compareOpen}
          onNavClick={handleNavClick}
          onOpenAnalysisForm={() => setShowAnalysisForm(true)}
          onAbortStuck={handleAbortStuck}
          onRetry={handleRetry}
          onAddToWatchlist={handleAddToWatchlist}
          onRerun={handleRerun}
          onCompareOpenChange={setCompareOpen}
        />
      )}

      <AnalysisDialogs
        compareOpen={compareOpen}
        onCompareOpenChange={setCompareOpen}
        currentAnalysis={currentAnalysisMeta}
        currentSummary={stream.summaryJson}
        recentAnalyses={recentAnalyses}
        conflictAnalysis={conflictAnalysis}
        onDismissConflict={lifecycle.dismissConflict}
        onViewConflict={handleViewOngoing}
        onCancelAndNew={handleCancelAndNew}
      />
    </>
  );
}
