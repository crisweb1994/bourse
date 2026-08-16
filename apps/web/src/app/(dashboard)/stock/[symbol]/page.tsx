'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { abortAnalysis } from '@/lib/api';
import { useAnalysisStream } from '@/hooks/use-analysis-stream';
import { useStuckWatchdog } from '@/hooks/use-stuck-watchdog';
import { useEarningsCard } from '@/hooks/use-earnings-card';
import { useStockNews } from '@/hooks/use-stock-news';
import { StockHeader } from '@/components/stock/stock-header';
import { StockPriceChart } from '@/components/charts/stock-price-chart';
import { EarningsCardPanel } from '@/components/earnings/earnings-card-panel';
import { EarningsTrendPanel } from '@/components/earnings/earnings-trend-panel';
import { InvestorRelationsTimeline } from '@/components/investor-relations/investor-relations-timeline';
import { useInvestorRelations } from '@/hooks/use-investor-relations';
import type { InvestorRelationsEventDto } from '@bourse/shared-types';
import { Card, toast } from '@/components/ui';
import { AnalysisLauncher } from './_components/analysis-launcher';
import { AnalysisStreamView } from './_components/analysis-stream-view';
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
    selectedMode,
    setSelectedMode,
    selectedFocusWindow,
    setSelectedFocusWindow,
    selectedSettingId,
    setSelectedSettingId,
    selectedModel,
    setSelectedModel,
    question,
    setQuestion,
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
    handleToggleWatchlist,
  } = useStockResolution({ symbol, market, name, stockId });
  const resolvedName = detail?.stock?.name ?? name;

  const earnings = useEarningsCard({
    stockId: effectiveStockId,
    canGenerate: Boolean(watchlistItemId),
  });
  const news = useStockNews({
    symbol,
    market,
    stockId: effectiveStockId,
    enabled: Boolean(effectiveStockId),
  });
  const investorRelations = useInvestorRelations({
    stockId: effectiveStockId,
    canGenerate: Boolean(watchlistItemId),
  });

  // The lifecycle hook owns history loading, report creation and stream attach.
  const lifecycle = useStockAnalysisLifecycle({
    stream,
    effectiveStockId,
    analysisId,
    symbol,
    market,
    name: resolvedName,
    router,
    formSettingId: selectedSettingId,
    formModel: selectedModel,
  });
  const {
    recentAnalyses,
    currentAnalysisMeta,
    checkingOngoing,
    loading,
  } = lifecycle;
  const handleStartAnalysis = async () => {
    const started = await lifecycle.startAnalysis({
      mode: selectedMode,
      focusWindow: selectedFocusWindow,
      settingId: selectedSettingId || undefined,
      model: selectedModel || undefined,
      question: question.trim() || undefined,
    });
    if (started) {
      setQuestion('');
      setShowAnalysisForm(false);
    }
  };
  const handleRerun = lifecycle.rerun;
  const handleRetry = lifecycle.retryAnalysis;

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
      // The server has recorded cancellation; stop the local SSE and expose
      // the same terminal state immediately.
      stream.stopStream('CANCELLED');
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : '强制重置失败');
    } finally {
      setAborting(false);
    }
  };

  const resultLayout = useAnalysisResultLayout({
    stream,
    initialSections: currentAnalysisMeta?.sections ?? [],
  });
  const {
    sectionList,
    navItems,
    effectiveActive,
    failedSections,
    handleNavClick,
  } = resultLayout;

  const openAnalysisChat = (sectionType?: string) => {
    if (!symbol || !currentAnalysisMeta?.id) return;

    const search = new URLSearchParams({
      stock: symbol,
      market,
      analysis: currentAnalysisMeta.id,
    });
    if (sectionType) search.set('section', sectionType);
    router.push(`/chat?${search.toString()}`);
  };

  const openStockResearch = () => {
    if (!symbol) return;
    const search = new URLSearchParams({
      stock: symbol,
      market,
      draft: '1',
      from: 'stock_header',
    });
    // Keep the most recent completed Analysis available as context in Chat;
    // when there is no completed report, the same entry naturally opens free
    // research for the stock.
    if (currentAnalysisMeta?.id && currentAnalysisMeta.status === 'COMPLETED') {
      search.set('analysis', currentAnalysisMeta.id);
    }
    router.push(`/chat?${search.toString()}`);
  };

  const openPriceChartChat = () => {
    if (!symbol) return;
    const search = new URLSearchParams({
      stock: symbol,
      market,
      draft: '1',
      question: '请解释这张价格与技术结构图中的均线、支撑和阻力依据。',
    });
    router.push(`/chat?${search.toString()}`);
  };

  const openEarningsChat = () => {
    if (!symbol) return;
    const search = new URLSearchParams({ stock: symbol, market, draft: '1', earnings: '1' });
    router.push(`/chat?${search.toString()}`);
  };

  const openInvestorRelationsChat = (event: InvestorRelationsEventDto) => {
    if (!symbol) return;
    const search = new URLSearchParams({ stock: symbol, market, draft: '1', ir: event.id });
    router.push(`/chat?${search.toString()}`);
  };

  return (
    <>
      <StockPageBackButton router={router} />
      {symbol && (
        <StockHeader
          symbol={symbol}
          market={market}
          exchange={exchange}
          name={resolvedName}
          currency={
            detail?.stock?.currency ??
            (detail?.quote && !detail.quote.degraded
              ? detail.quote.currency
              : undefined)
          }
          stockId={effectiveStockId}
          inWatchlist={!!watchlistItemId}
          watchlistBusy={watchlistBusy}
          onToggleWatchlist={
            effectiveStockId ? handleToggleWatchlist : undefined
          }
          recentAnalyses={recentAnalyses}
          quote={detail?.quote ?? null}
          profile={detail?.profile ?? null}
          onOpenResearch={openStockResearch}
          onOpenAnalysis={() => setShowAnalysisForm(true)}
          news={news}
        />
      )}

      {/* Visualization D3 - L1 resident price chart (fixed 365d window D1) */}
      {symbol && <StockPriceChart symbol={symbol} market={market} onAsk={openPriceChartChat} />}

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

      {effectiveStockId && (
        <>
          <EarningsCardPanel
            response={earnings.response}
            generation={earnings.generation}
            loading={earnings.loading}
            error={earnings.error}
            onStart={() => void earnings.start()}
            onRetry={() => void earnings.retry()}
            onAsk={openEarningsChat}
            history={earnings.history}
            historyLoading={earnings.historyLoading}
            onLoadHistory={() => void earnings.loadHistory()}
          />
          <EarningsTrendPanel stockId={effectiveStockId} />
          <InvestorRelationsTimeline
            response={investorRelations.response}
            generation={investorRelations.generation}
            loading={investorRelations.loading}
            error={investorRelations.error}
            onRetry={() => void investorRelations.retry()}
            onAsk={openInvestorRelationsChat}
          />
        </>
      )}

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
        selectedMode={selectedMode}
        setSelectedMode={setSelectedMode}
        selectedFocusWindow={selectedFocusWindow}
        setSelectedFocusWindow={setSelectedFocusWindow}
        providerSettings={providerSettings}
        selectedSettingId={selectedSettingId}
        setSelectedSettingId={setSelectedSettingId}
        selectedModel={selectedModel}
        setSelectedModel={setSelectedModel}
        question={question}
        setQuestion={setQuestion}
        loading={loading}
        stockId={effectiveStockId}
        stockLabel={resolvedName || symbol || ''}
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
          sectionList={sectionList}
          navItems={navItems}
          effectiveActive={effectiveActive}
          failedSections={failedSections}
          stuckSuspected={stuckSuspected}
          aborting={aborting}
          showMetaBar={!showAnalysisForm}
          symbol={symbol}
          market={market}
          watchlistItemId={watchlistItemId}
          watchlistBusy={watchlistBusy}
          onNavClick={handleNavClick}
          onOpenAnalysisForm={() => setShowAnalysisForm(true)}
          onStop={handleAbortStuck}
          onAbortStuck={handleAbortStuck}
          onRetry={handleRetry}
          onAddToWatchlist={handleAddToWatchlist}
          onRerun={handleRerun}
          onAskAnalysis={openAnalysisChat}
        />
      )}

    </>
  );
}
