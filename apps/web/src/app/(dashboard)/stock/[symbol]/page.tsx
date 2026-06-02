'use client';

import { useState, useEffect, useMemo, useRef } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import {
  Loader2,
  Square,
  ChevronLeft,
  RotateCcw,
  Clock,
  Sparkles,
  Bot,
  AlertCircle,
  AlertTriangle,
} from 'lucide-react';
import {
  addToWatchlist,
  getWatchlist,
  getStockDetail,
  type StockDetailResult,
  abortAnalysis,
  listAiProviderSettings,
  type AiProviderSettingDto,
} from '@/lib/api';
import { useAnalysisStream } from '@/hooks/use-analysis-stream';
import { useStuckWatchdog } from '@/hooks/use-stuck-watchdog';
import { useScrollSpy } from '@/hooks/use-scroll-spy';
import { MarkdownRenderer } from '@/components/shared/markdown-renderer';
import { ConclusionBanner } from '@/components/analysis/conclusion-banner';
import {
  LeftSectionNav,
  type NavItem,
} from '@/components/analysis/left-section-nav';
import { ScrollSection } from '@/components/analysis/scroll-section';
import { RightInsightsPanel } from '@/components/analysis/right-insights-panel';
import { ReportActionsBar } from '@/components/analysis/report-actions-bar';
import { StockHeader } from '@/components/stock/stock-header';
import {
  Button,
  Card,
  Dialog,
  Pill,
  SectionTag,
  toast,
} from '@/components/ui';
import { cn } from '@/lib/utils';
import { ResearchProgressStrip } from '@/components/analysis/research-progress-strip';
import {
  ANALYSIS_TYPES,
  buildRightInsightsSummary,
  formatAnalysisTime,
  getRequestedAnalysisId,
} from './stock-page-ui';
import { ANALYSIS_TYPE_LABELS as SECTION_LABELS } from '@/lib/constants';
import { ResolutionRecovery, ResolutionEmpty } from './_components/resolution';
import { AnalysisForm } from './_components/analysis-form';
import { ComprehensiveSummaryCard } from './_components/comprehensive-summary-card';
import { CompareDialog } from './_components/compare-dialog';
import { ConflictDialog, SwitchedNotice } from './_components/conflict-dialog';
import { useStockAnalysisLifecycle } from './use-stock-analysis-lifecycle';

const COMPREHENSIVE_SECTION_TYPES = ANALYSIS_TYPES.filter(
  (type) => type.value !== 'COMPREHENSIVE',
).map((type) => type.value);

export default function StockAnalysisPage({
  params,
}: {
  params: Promise<{ symbol: string }>;
}) {
  const [resolvedParams, setResolvedParams] = useState<{
    symbol: string;
  } | null>(null);
  const searchParams = useSearchParams();
  const router = useRouter();
  const [selectedType, setSelectedType] = useState('FUNDAMENTAL');
  // plan-v2 Wave 3.1b — debate-related state removed.
  const [selectedSettingId, setSelectedSettingId] = useState('');
  const [selectedModel, setSelectedModel] = useState('');
  const [providerSettings, setProviderSettings] = useState<
    AiProviderSettingDto[]
  >([]);
  const [aborting, setAborting] = useState(false);

  // PR-3 / plan-v2 §12.1 — single getStockDetail call drives both
  // stockId resolution (via .stock.id) and the header's quote/profile
  // panel (passed down as props). Previously page.tsx + stock-header.tsx
  // each issued their own request — every cold visit paid 2× HTTP cost.
  const [detail, setDetail] = useState<StockDetailResult | null>(null);
  const [resolvingStock, setResolvingStock] = useState(false);

  // PR-4 · header state
  const [watchlistItemId, setWatchlistItemId] = useState<string | null>(null);
  const [watchlistBusy, setWatchlistBusy] = useState(false);
  const [showAnalysisForm, setShowAnalysisForm] = useState(false);

  const [manualActive, setManualActive] = useState<string | null>(null);
  const lockUntilRef = useRef(0);

  const stream = useAnalysisStream();

  useEffect(() => {
    params.then(setResolvedParams);
  }, [params]);

  const symbol = resolvedParams
    ? decodeURIComponent(resolvedParams.symbol)
    : null;
  const stockId = searchParams.get('stockId');
  const market = searchParams.get('market') || '';
  const name = searchParams.get('name') || symbol || '';
  const analysisId = getRequestedAnalysisId(searchParams);

  useEffect(() => {
    if (!symbol) return;
    const prev = document.title;
    document.title = name && name !== symbol ? `${symbol} · ${name}` : symbol;
    return () => {
      document.title = prev;
    };
  }, [symbol, name]);

  // Always fetch detail when (symbol, market) is known — server returns
  // {stock, quote, profile, candidates} in one round-trip. `stock=null +
  // candidates[]` shape is the recovery path the old `lookupStock`
  // endpoint exposed; preserved here.
  //
  // stockId is intentionally NOT a dependency: the fetch is keyed on
  // (symbol, market) so a URL change that adds/removes ?stockId= would
  // re-fetch identical data. handleAddToWatchlist + the analysis-create
  // flow both mutate the URL stockId post-success, and we want neither
  // to trigger a wasted second roundtrip. The initial-load skeleton
  // (resolvingStock=true) reads stockId at effect-run time, which is
  // the same value React would see in the deps array.
  useEffect(() => {
    if (!symbol || !market) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    if (!stockId) setResolvingStock(true);
    getStockDetail(symbol, market)
      .then((r) => {
        if (!cancelled) setDetail(r);
      })
      .catch(() => {
        if (!cancelled) {
          setDetail({
            stock: null,
            quote: null,
            profile: null,
            candidates: [],
          });
        }
      })
      .finally(() => {
        if (!cancelled) setResolvingStock(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol, market]);

  const effectiveStockId = stockId ?? detail?.stock?.id ?? null;

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

  // PR-4 · watchlist membership check. When effectiveStockId resolves, ask
  // the user's watchlist once; the toggle later updates state in-place.
  useEffect(() => {
    if (!effectiveStockId) {
      setWatchlistItemId(null);
      return;
    }
    let cancelled = false;
    getWatchlist()
      .then((items) => {
        if (cancelled) return;
        const match = items.find((i) => i.stockId === effectiveStockId);
        setWatchlistItemId(match?.id ?? null);
      })
      .catch(() => {
        if (!cancelled) setWatchlistItemId(null);
      });
    return () => {
      cancelled = true;
    };
  }, [effectiveStockId]);

  useEffect(() => {
    let cancelled = false;
    listAiProviderSettings()
      .then((items) => {
        if (cancelled) return;
        const enabled = items.filter((s) => s.enabled);
        setProviderSettings(enabled);
        const def = enabled.find((s) => s.isDefault) ?? enabled[0];
        if (def) {
          setSelectedSettingId(def.id);
          setSelectedModel(def.enabledModels[0] ?? '');
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

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

  const sectionList = useMemo(
    () => Object.values(stream.sections).sort((a, b) => a.order - b.order),
    [stream.sections],
  );

  // Drive the layout off the ACTUAL run (currentAnalysisMeta), not the form's
  // `selectedType` — the new-analysis form mutates selectedType on every type
  // button click, and coupling the view to it made the displayed report flip
  // between single/comprehensive layouts just by opening the form.
  const isComprehensiveRun =
    currentAnalysisMeta?.analysisType === 'COMPREHENSIVE' ||
    sectionList.length > 1 ||
    !!stream.summaryMarkdown;
  const isMultiSection =
    sectionList.length > 1 || (isComprehensiveRun && sectionList.length > 0);

  const scrollIds = useMemo(() => {
    const ids = sectionList.map((s) => `section-${s.type}`);
    if (stream.summaryMarkdown) ids.push('section-SUMMARY');
    return ids;
  }, [sectionList, stream.summaryMarkdown]);

  const spiedActiveId = useScrollSpy(scrollIds);

  const effectiveActive =
    Date.now() < lockUntilRef.current
      ? manualActive
      : (spiedActiveId ??
        (sectionList[0] ? `section-${sectionList[0].type}` : null));

  const handleNavClick = (id: string) => {
    setManualActive(id);
    lockUntilRef.current = Date.now() + 1500;
    document
      .getElementById(id)
      ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const navItems = useMemo<NavItem[]>(() => {
    const sectionByType = new Map(
      sectionList.map((section) => [section.type, section]),
    );
    const navTypes = isComprehensiveRun
      ? COMPREHENSIVE_SECTION_TYPES
      : sectionList.map((section) => section.type);

    const items: NavItem[] = navTypes.map((type) => {
      const section = sectionByType.get(type);
      return {
        id: `section-${type}`,
        label: SECTION_LABELS[type] || type,
        status: section?.status ?? 'pending',
      };
    });
    if (stream.summaryMarkdown) {
      items.push({
        id: 'section-SUMMARY',
        label: '综合总览',
        status: 'completed',
        isSummary: true,
      });
    }
    return items;
  }, [isComprehensiveRun, sectionList, stream.summaryMarkdown]);

  const rightInsightsSummary = useMemo(
    () => buildRightInsightsSummary(stream.summaryJson, sectionList),
    [sectionList, stream.summaryJson],
  );
  const hasRightPanel = isMultiSection && !!rightInsightsSummary;

  const failedSections = useMemo(
    () => sectionList.filter((s) => s.status === 'failed'),
    [sectionList],
  );
  // PR-4 · watchlist toggle (add only — removal stays in /watchlist page).
  // When the user is not yet on the watchlist and we have a candidate from
  // the detail response, we use that exact StockSearchResult shape;
  // otherwise we synthesize one from the URL + provider name.
  const handleAddToWatchlist = async () => {
    if (watchlistItemId || watchlistBusy) return;
    const candidate = detail?.candidates?.[0];
    const seed = candidate ?? (symbol
      ? {
          symbol,
          name: name || symbol,
          market,
          exchange: detail?.stock?.exchange ?? '',
          currency: detail?.stock?.currency ?? 'USD',
          yahooSymbol: detail?.stock?.yahooSymbol ?? undefined,
        }
      : null);
    if (!seed || !seed.symbol || !seed.market) {
      toast.error('股票信息不完整，无法加入自选');
      return;
    }
    setWatchlistBusy(true);
    try {
      const item = await addToWatchlist(seed);
      setWatchlistItemId(item.id);
      // If this also resolved the stockId for the first time, the detail
      // effect will not re-run on its own; merge the resolved stock into
      // local state so effectiveStockId picks it up immediately.
      if (!stockId && !detail?.stock) {
        setDetail((prev) => ({
          stock: {
            id: item.stockId,
            symbol: item.stock.symbol,
            name: item.stock.name,
            market: item.stock.market,
            exchange: item.stock.exchange,
            currency: item.stock.currency,
            yahooSymbol: item.stock.yahooSymbol,
          },
          quote: prev?.quote ?? null,
          profile: prev?.profile ?? null,
          candidates: [],
        }));
      }
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : '加入自选失败');
    } finally {
      setWatchlistBusy(false);
    }
  };

  const [compareOpen, setCompareOpen] = useState(false);

  return (
    <>
      {/* Header — S2-4: prefer router.back when there's history (came from
          watchlist / history / search), else fall back to /watchlist. */}
      <div className="mb-2">
        <button
          type="button"
          onClick={() => {
            if (typeof window !== 'undefined' && window.history.length > 1) {
              router.back();
            } else {
              router.push('/watchlist');
            }
          }}
          className="inline-flex items-center gap-1 text-[12.5px] text-[var(--color-fg-2)] hover:text-[var(--color-fg)] transition-colors"
        >
          <ChevronLeft className="w-3.5 h-3.5" strokeWidth={1.5} />
          返回
        </button>
      </div>
      {/* ④ · SwitchedNotice — surfaces when we auto-switched to an ongoing
          analysis after a 409. Lets the user undo / understand. */}
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
            !watchlistItemId && (effectiveStockId || detail?.candidates?.length)
              ? handleAddToWatchlist
              : undefined
          }
          recentAnalyses={recentAnalyses}
          quote={detail?.quote ?? null}
          profile={detail?.profile ?? null}
        />
      )}

      {/* PR-3 · resolution recovery — shown when URL has symbol but no stockId
          and the detail lookup found no DB match. Search candidates surface
          so the user can confirm + add to watchlist. */}
      {!stockId &&
        !effectiveStockId &&
        !resolvingStock &&
        detail &&
        detail.candidates.length > 0 && (
          <ResolutionRecovery
            symbol={symbol ?? ''}
            candidates={detail.candidates}
            onAddAndAnalyze={async () => {
              await handleAddToWatchlist();
              setShowAnalysisForm(true);
            }}
            onAddOnly={handleAddToWatchlist}
            busy={watchlistBusy}
          />
        )}
      {!stockId && !effectiveStockId && !resolvingStock && detail && detail.candidates.length === 0 && (
        <ResolutionEmpty symbol={symbol ?? ''} />
      )}
      {!stockId && !effectiveStockId && resolvingStock && (
        <Card className="mb-6">
          <div className="flex items-center gap-2 px-5 py-3.5 text-[13px] text-[var(--color-fg-2)]">
            <Loader2 className="w-3.5 h-3.5 animate-spin" strokeWidth={1.5} />
            正在识别股票…
          </div>
        </Card>
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

      {/* S3-7 · New-analysis form rendered as a Dialog (backdrop + ESC +
          scroll lock + focus trap). Always uses the same Dialog regardless
          of whether stream is idle or completed — visual treatment is now
          consistent. */}
      <Dialog
        open={showAnalysisForm}
        onOpenChange={(v) => setShowAnalysisForm(v)}
        ariaLabel="新建分析"
        titleSlot="新建分析"
        size="lg"
      >
        <AnalysisForm
          selectedType={selectedType}
          setSelectedType={setSelectedType}
          providerSettings={providerSettings}
          selectedSettingId={selectedSettingId}
          setSelectedSettingId={setSelectedSettingId}
          selectedModel={selectedModel}
          setSelectedModel={setSelectedModel}
          loading={loading}
          stockId={effectiveStockId}
          onStart={handleStartAnalysis}
          onCancel={() => setShowAnalysisForm(false)}
          embedded
        />
      </Dialog>

      {/* Empty state — only when we have a resolved stockId. The resolution
          recovery card above handles the no-stockId case. */}
      {stream.status === 'idle' &&
        !checkingOngoing &&
        !showAnalysisForm &&
        effectiveStockId && (
          <Card className="mb-6">
            <div className="flex flex-col items-center gap-4 py-16 px-8 text-center">
              <Sparkles
                className="w-7 h-7 text-[var(--color-fg-3)]"
                strokeWidth={1.5}
              />
              <div>
                <p className="text-[14px] font-medium text-[var(--color-fg)]">
                  暂无分析记录
                </p>
                <p className="mt-1 max-w-xs text-[12.5px] text-[var(--color-fg-2)] leading-[1.6]">
                  对 <Sym>{name || symbol}</Sym> 开启 AI
                  深度分析，获取基本面、估值、风险等多维度洞察。
                </p>
              </div>
              <Button
                variant="primary"
                size="lg"
                onClick={() => setShowAnalysisForm(true)}
              >
                <Sparkles className="w-3.5 h-3.5" strokeWidth={1.5} />
                开始 AI 分析
              </Button>
            </div>
          </Card>
        )}



      {/* Stream/completed content */}
      {stream.status !== 'idle' && (
        <div className="space-y-4">
          {/* Meta bar — PR-9: lightweight inline strip, not a full Card. */}
          {currentAnalysisMeta && !showAnalysisForm && (
            <div
              className={
                'flex flex-wrap items-center gap-x-4 gap-y-1.5 ' +
                'rounded-[var(--radius-btn)] border border-[var(--color-border-soft)] ' +
                'bg-[var(--color-bg-elev)] px-4 py-2.5 ' +
                'text-[12px] text-[var(--color-fg-2)]'
              }
            >
              <Pill variant="emerald">
                {ANALYSIS_TYPES.find(
                  (t) => t.value === currentAnalysisMeta.analysisType,
                )?.label || currentAnalysisMeta.analysisType}
              </Pill>
              <span className="inline-flex items-center gap-1 font-mono">
                <Clock className="w-3 h-3" strokeWidth={1.5} />
                {formatAnalysisTime(
                  currentAnalysisMeta.generatedAt ||
                    currentAnalysisMeta.createdAt,
                )}
              </span>
              {(currentAnalysisMeta.aiModel ||
                currentAnalysisMeta.aiProvider) && (
                <span className="inline-flex items-center gap-1 font-mono">
                  <Bot className="w-3 h-3" strokeWidth={1.5} />
                  {currentAnalysisMeta.aiModel ||
                    currentAnalysisMeta.aiProvider}
                </span>
              )}
              <span className="ml-auto inline-flex items-center gap-2">
                {/* plan-v2 Wave 3.1b — 基于此发起合议 button removed with DEBATE workflow */}
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => setShowAnalysisForm(true)}
                  disabled={stream.status === 'streaming'}
                >
                  <Sparkles className="w-3 h-3" strokeWidth={1.5} />
                  新分析
                </Button>
              </span>
            </div>
          )}

          {/* Failure banner */}
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
                              onClick={() =>
                                handleNavClick(`section-${s.type}`)
                              }
                              className="font-medium underline hover:no-underline"
                            >
                              {SECTION_LABELS[s.type] || s.type}
                            </button>
                          </span>
                        ))}
                      </p>
                    )}
                  </div>
                  <Button
                    size="sm"
                    onClick={() => setShowAnalysisForm(true)}
                  >
                    重新分析
                  </Button>
                </div>
              </Card>
            )}

          {/* When another tab/process owns the live SSE, the backend refuses
              attach. The hook flags `attachedElsewhere`, polls, and replays
              once the analysis finishes — surface a calm waiting notice
              instead of a failure banner. */}
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

          {/* PR-6: data quality notice — shows only when a realtime source
              degraded to web search. */}
          <ResearchProgressStrip degraded={stream.degraded} />

          {/* Conclusion banners */}
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

          {/* Stop streaming */}
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
                  <Button size="sm" onClick={handleAbortStuck} disabled={aborting}>
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

          {/* Multi-section layout */}
          {isMultiSection && (
            <div
              className={cn(
                'grid gap-6',
                hasRightPanel
                  ? 'lg:grid-cols-[200px_1fr_320px]'
                  : 'lg:grid-cols-[200px_1fr]',
              )}
            >
              {/* Order: lg = Left → Center → Right (DOM). Mobile = Left
                  (sticky tabs) → Right (collapsible digest) → Center.
                  Right uses `order-2 lg:order-3` to swap visual position. */}
              <div className="order-1 lg:order-1">
                <LeftSectionNav
                  items={navItems}
                  activeId={effectiveActive}
                  onSelect={handleNavClick}
                />
              </div>

              <div className="order-3 lg:order-2 min-w-0 space-y-6">
                {sectionList.map((sec) => (
                  <ScrollSection
                    key={sec.type}
                    section={sec}
                    onRetry={handleRetry}
                    showSideContent={false}
                    showCitations={true}
                  />
                ))}

                {/* Summary section */}
                {stream.summaryMarkdown && (
                  <section
                    id="section-SUMMARY"
                    className="scroll-mt-4"
                  >
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
                        <MarkdownRenderer
                          content={stream.summaryMarkdown}
                        />
                        {stream.summaryJson && (
                          <div className="mt-6">
                            <ComprehensiveSummaryCard
                              data={stream.summaryJson}
                            />
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

          {/* Single section */}
          {!isMultiSection && sectionList.length === 1 && (
            <ScrollSection
              section={sectionList[0]}
              onRetry={handleRetry}
              showSideContent={true}
            />
          )}

          {/* Initial loader */}
          {stream.status === 'streaming' && sectionList.length === 0 && (
            <Card>
              <div className="flex items-center gap-2 px-5 py-4 text-[13px] text-[var(--color-fg-2)]">
                <span className="stream-dot" />
                正在初始化分析…
              </div>
            </Card>
          )}

          {/* Completed footer */}
          {stream.status === 'completed' &&
            sectionList.some((s) => s.status === 'failed') && (
              <p className="text-[11.5px] text-[var(--color-fg-2)]">
                部分维度分析失败，可在对应维度点击重试
              </p>
            )}

          {/* S2-1 + S2-3 · Report actions bar (copy / export / debate / rerun
              / watchlist). Renders only when the analysis has actually
              completed and the user has somewhere to send the report. */}
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
              onAddToWatchlist={!watchlistItemId ? handleAddToWatchlist : undefined}
              onRerun={handleRerun}
              onCompareWithLast={
                recentAnalyses.filter(
                  (a) =>
                    a.id !== currentAnalysisMeta?.id &&
                    a.analysisType === currentAnalysisMeta?.analysisType &&
                    a.status === 'COMPLETED',
                ).length > 0
                  ? () => setCompareOpen(true)
                  : undefined
              }
              comparing={compareOpen}
            />
          )}
        </div>
      )}

      {/* S4+ · 上一次 vs 这次 diff dialog */}
      {compareOpen && currentAnalysisMeta && (
        <CompareDialog
          open={compareOpen}
          onClose={() => setCompareOpen(false)}
          current={currentAnalysisMeta}
          currentSummary={stream.summaryJson}
          recents={recentAnalyses}
        />
      )}

      {/* ③ · ConflictDialog — preempt the "Analysis is already running"
          backend error by checking recentAnalyses before submitting. */}
      {conflictAnalysis && (
        <ConflictDialog
          open={!!conflictAnalysis}
          onClose={lifecycle.dismissConflict}
          ongoing={conflictAnalysis}
          onView={handleViewOngoing}
          onCancelAndNew={handleCancelAndNew}
        />
      )}
    </>
  );
}

function Sym({ children }: { children: React.ReactNode }) {
  return (
    <span className="font-medium text-[var(--color-fg)]">
      {children}
    </span>
  );
}

