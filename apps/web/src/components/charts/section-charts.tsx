'use client';

/**
 * SectionCharts — per-module chart dispatcher (visualization §四/§六).
 *
 * Data rules:
 *  - C3/C4 read the section's structuredJson (existing SSE/REST contract).
 *  - C2/C5 read evidence.chartFacts (GET /evidence) — per product decision
 *    D2, C2 renders whenever the data exists, even when the VALUATION module
 *    itself was SKIPPED (QUICK mode).
 *  - I11 (v2.2): peHistorySeries < 3 points → explicit empty state
 *    "估值历史不足"（degenerate percentile must not render as a chart）.
 */

import { useEffect, useState } from 'react';
import type { FocusWindow, SectionType, ChartEvidenceResponse, ChartPriceSeries } from '@bourse/shared-types';
import { ChartFrame } from './chart-frame';

const DEGRADED_NOTE = '数据降级：图表基于部分来源生成，请结合数据质量提示阅读';
import { PercentileBand } from './primitives/percentile-band';
import { ScenarioRangeBar, type ScenarioRange } from './primitives/range-bar';
import { RiskMatrix, type RiskItem } from './primitives/risk-matrix';
import { ComboBarLine, type PeriodTrend } from './primitives/combo-bar-line';
import { PeerBulletBar } from './primitives/bullet-bar';
import { SensitivityCurve, type SensitivityPoint } from './primitives/sensitivity-curve';
import { PriceChart, type CorporateActionForChart, type TechnicalForChart } from './price-chart/price-chart';
import { MessageSquareText } from 'lucide-react';

interface ValuationShape {
  fairValuePerShare?: number | null;
  peHistorySeries?: Array<{ period: string; fiscalYearEnd?: string; pe: number }> | null;
  pe5yHigh?: number | null;
  pe5yLow?: number | null;
  pe5yMedian?: number | null;
  pe5yPercentile?: number | null;
  impliedGrowthRate?: number | null;
  baseCurrency?: string | null;
  dcfSensitivity?: { points: SensitivityPoint[] } | null;
}

interface PeerComparisonShape {
  sector?: string;
  subjectVsPeerMedian?: Record<
    string,
    { subject: number | null; median: number | null; rankPercentile: number | null; peerCount: number }
  >;
}

export function SectionCharts({
  sectionType,
  structuredJson,
  evidence,
  sectionStatus,
  market = 'US',
  focusWindow = '1Y',
  analysisTerminal = false,
  onEvidenceRetry,
  onRerun,
  onAsk,
  onJump,
}: {
  sectionType: SectionType;
  structuredJson?: Record<string, unknown> | null;
  evidence?: { status: string; data?: ChartEvidenceResponse } | null;
  sectionStatus?: string;
  market?: string;
  focusWindow?: FocusWindow;
  analysisTerminal?: boolean;
  onEvidenceRetry?: () => void;
  onRerun?: () => void;
  onAsk?: (sectionType: string) => void;
  onJump?: (sectionType: string) => void;
}) {
  const defaultRangeDays = FOCUS_RANGE_DAYS[focusWindow];
  const [rangeDays, setRangeDays] = useState(defaultRangeDays);
  const degraded = evidence?.status === 'ready' && evidence.data?.degraded === true;
  const chartFacts = evidence?.status === 'ready' ? evidence.data?.chartFacts : undefined;
  const valuation = chartFacts?.valuation as ValuationShape | null | undefined;
  const peerComparison = chartFacts?.peerComparison as PeerComparisonShape | null | undefined;
  const quote = chartFacts?.quote ?? null;
  const evidenceReady = evidence?.status === 'ready';
  const evidenceLoading = !evidence || evidence.status === 'idle' || evidence.status === 'loading';
  const evidenceErrorMessage = (evidence as { message?: string } | null | undefined)?.message;
  const evidenceReason = (evidence as { reason?: string } | null | undefined)?.reason;
  const evidenceEmptyMessage = evidence?.status === 'error'
    ? `图表数据加载失败：${evidenceErrorMessage ?? '未知错误'}`
    : evidence?.status === 'unavailable'
      ? `暂无快照证据（${evidenceReason ?? 'no_snapshot'}）`
      : '图表数据尚未就绪';
  const evidenceRetry = evidence?.status === 'error' ? onEvidenceRetry : undefined;
  const oldSnapshot = analysisTerminal && evidence?.status === 'unavailable' && evidenceReason === 'no_snapshot';
  const unavailableMessage = oldSnapshot
    ? '该分析早于图表功能上线，当前没有可回放的图表快照'
    : evidenceEmptyMessage;
  const evidenceActions = {
    onRetry: evidenceRetry,
    onRerun: oldSnapshot ? onRerun : undefined,
  };
  const ratios = chartFacts?.ratios as { periodTrends?: unknown[]; computedAt?: unknown } | null | undefined;
  const technical = chartFacts?.technical as TechnicalForChart | null | undefined;
  const corporateActions = Array.isArray(chartFacts?.corporateActions)
    ? chartFacts.corporateActions as CorporateActionForChart[]
    : [];

  useEffect(() => {
    setRangeDays(defaultRangeDays);
  }, [defaultRangeDays]);

  if (sectionType === 'VALUATION_SCENARIOS') {
    const series = valuation?.peHistorySeries ?? [];
    const showC2 = series.length >= 3; // I11; degraded evidence still renders with a note
    const valuationSkipped = sectionStatus === 'skipped';

    const scenarios = (structuredJson?.scenarios as ScenarioRange[] | undefined) ?? [];
    const price = quote?.price;
    const showC3 = scenarios.some((s) => s.valueRange) && typeof price === 'number';

    return (
      <div className="space-y-3">
        {!evidenceReady ? (
          <ChartFrame
            title="PE 历史 · 5 年分位带"
            status={evidenceLoading ? 'loading' : 'empty'}
            emptyReason={{ message: unavailableMessage }}
            {...evidenceActions}
          />
        ) : valuation ? (
          showC2 ? (
            <ChartFrame
              title="PE 历史 · 5 年分位带"
              status="ready"
              asOf={latestValuationDate(series)}
              sourceTier={evidence?.data?.provenance.financials ?? null}
              degradedNote={degraded ? DEGRADED_NOTE : undefined}
              ariaSummary={`PE 历史 ${series.length} 个财年点位，当前 5 年分位 ${
                valuation.pe5yPercentile != null ? Math.round(valuation.pe5yPercentile) : '—'
              }%`}
            >
              <PercentileBand
                series={series}
                currentPe={quote?.pe ?? null}
                percentile={valuation.pe5yPercentile}
                high={valuation.pe5yHigh}
                median={valuation.pe5yMedian}
                low={valuation.pe5yLow}
                onCurrentClick={() => {
                  const finding = typeof document !== 'undefined'
                    ? document.querySelector('#section-VALUATION_SCENARIOS [data-finding]')
                    : null;
                  if (finding instanceof HTMLElement) {
                    finding.scrollIntoView({ behavior: 'smooth', block: 'center' });
                  } else {
                    onJump?.('VALUATION_SCENARIOS');
                  }
                }}
              />
            </ChartFrame>
          ) : (
            <ChartFrame
              title="PE 历史 · 5 年分位带"
              status="empty"
              sourceTier={evidence?.data?.provenance.financials ?? null}
              emptyReason={{ message: '估值历史不足（财年点位 < 3），无法绘制分位带' }}
            />
          )
        ) : (
          <ChartFrame
            title="PE 历史 · 5 年分位带"
            status="empty"
            sourceTier={evidence?.data?.provenance.financials ?? null}
            emptyReason={{ message: '缺少代码计算的 PE 历史事实' }}
          />
        )}

        {valuationSkipped ? null : !evidenceReady ? (
          <ChartFrame
            title="情景价值区间"
            status={evidenceLoading ? 'loading' : 'empty'}
            emptyReason={{ message: unavailableMessage }}
            {...evidenceActions}
          />
        ) : showC3 ? (
          <ChartFrame
            title="情景价值区间"
            status="ready"
            asOf={quote?.asOf ?? null}
            sourceTier={evidence?.data?.provenance.quote ?? null}
            degradedNote={degraded ? DEGRADED_NOTE : undefined}
            ariaSummary={`熊基准牛三档价值区间对比当前价 ${price!.toFixed(1)}`}
          >
            <ScenarioRangeBar
              scenarios={scenarios}
              currentPrice={price!}
              currency={scenarios.find((s) => s.valueRange)?.valueRange?.currency ?? quote?.currency ?? ''}
              impliedGrowth={valuation?.impliedGrowthRate ?? null}
              codeComputed={valuation?.fairValuePerShare != null}
            />
          </ChartFrame>
        ) : scenarios.length > 0 || valuation ? (
          // PRD C3 验收：模块有估值内容但无合法区间（如 enforce 置空）→
          // 显式"证据不足"，不返回 null 装作没这回事
          <ChartFrame
            title="情景价值区间"
            status="empty"
            emptyReason={{ message: '证据不足，未生成估值区间（代码未计算出公允价值，模型不得编造数字）' }}
          />
        ) : (
          <ChartFrame
            title="情景价值区间"
            status="empty"
            emptyReason={{ message: '缺少结构化情景数据' }}
          />
        )}

        {/* C9 · 反向 DCF 敏感度曲线（确定性扫描，非预测） */}
        {!valuationSkipped && valuation?.dcfSensitivity?.points?.length ? (
          <ChartFrame
            title="反向 DCF 敏感度"
            status="ready"
            asOf={quote?.asOf ?? null}
            sourceTier={evidence?.data?.provenance.financials ?? null}
            degradedNote={degraded ? DEGRADED_NOTE : undefined}
            ariaSummary={`公允价值随假设增长率变化；现价隐含 ${valuation.impliedGrowthRate != null ? (valuation.impliedGrowthRate * 100).toFixed(1) : '—'}% 增长`}
          >
            <SensitivityCurve
              points={valuation.dcfSensitivity.points}
              currentPrice={typeof price === 'number' ? price : null}
              impliedGrowth={valuation.impliedGrowthRate ?? null}
              currency={valuation.baseCurrency ?? quote?.currency ?? undefined}
            />
          </ChartFrame>
        ) : null}

        {/* C8 · 同行分位条（quotes-only 口径，基本面指标如实缺省） */}
        {!valuationSkipped && peerComparison?.subjectVsPeerMedian ? (
          <ChartFrame
            title={`同行对比${peerComparison.sector ? ` · ${peerComparison.sector}` : ''}`}
            status="ready"
            asOf={quote?.asOf ?? null}
            sourceTier={evidence?.data?.provenance.quote ?? null}
            degradedNote={degraded ? DEGRADED_NOTE : undefined}
            ariaSummary="本公司估值指标相对同行中位数的分位"
          >
            <PeerBulletBar subjectVsPeerMedian={peerComparison.subjectVsPeerMedian} />
          </ChartFrame>
        ) : null}
      </div>
    );
  }

  if (sectionType === 'RISK_REGISTER') {
    if (sectionStatus === 'skipped') return null;
    const risks = (structuredJson?.risks as RiskItem[] | undefined) ?? [];
    if (!risks.length) {
      return (
        <ChartFrame
          title="风险矩阵"
          status="empty"
          emptyReason={{ message: '暂无可用于定位的结构化风险（模块可能未完成或数据不足）' }}
        />
      );
    }
    return (
        <ChartFrame
          title="风险矩阵"
          status="ready"
          degradedNote={degraded ? DEGRADED_NOTE : undefined}
          ariaSummary={`${risks.length} 项风险按概率与影响分布，点击编号查看机制与监控指标`}
      >
        <RiskMatrix risks={risks} />
      </ChartFrame>
    );
  }

  if (sectionType === 'COMPANY_QUALITY') {
    const trends =
      (ratios?.periodTrends as PeriodTrend[] | undefined) ?? [];
    if (!trends.length) {
      return (
        <ChartFrame
          title="财务趋势"
          status={evidenceLoading ? 'loading' : 'empty'}
          sourceTier={evidence?.data?.provenance.financials ?? null}
          emptyReason={{ message: evidenceReady ? '缺少至少两期可比财务趋势数据' : unavailableMessage }}
          {...evidenceActions}
        />
      );
    }
    return (
      <ChartFrame
        title="财务趋势"
        status="ready"
        asOf={typeof ratios?.computedAt === 'string' ? ratios.computedAt : null}
        sourceTier={evidence?.data?.provenance.financials ?? null}
        degradedNote={degraded ? DEGRADED_NOTE : undefined}
        ariaSummary={`营收与净利率趋势，共 ${trends.length} 期`}
      >
        <ComboBarLine trends={trends} onPeriodClick={() => onJump?.('COMPANY_QUALITY')} />
      </ChartFrame>
    );
  }

  if (sectionType === 'MARKET_SIGNALS') {
    const priceSeries = chartFacts?.priceSeries;
    if (!evidenceReady) {
      return (
        <ChartFrame
          title="价格走势与技术结构"
          status={evidenceLoading ? 'loading' : 'empty'}
          emptyReason={{ message: unavailableMessage }}
          {...evidenceActions}
        />
      );
    }
    if (!priceSeries?.bars?.length) {
      return (
        <ChartFrame
          title="价格走势与技术结构"
          status="empty"
          emptyReason={{ message: '缺少历史行情快照，无法绘制技术图' }}
          onRerun={oldSnapshot ? onRerun : undefined}
        />
      );
    }
    const mixedNote = priceSeries.basis === 'mixed'
      ? '复权口径混合：部分 K 线使用复权收盘，跨除权日请谨慎比较'
      : priceSeries.basis === 'raw' && (market === 'CN' || market === 'HK')
      ? '数据未复权：跨除权日的涨跌跳空为真实历史事件，趋势线在除权日会出现台阶'
      : undefined;
    const rangeOptions = availableRanges(priceSeries);
    const selectedRange = rangeOptions.includes(rangeDays)
      ? rangeDays
      : rangeOptions[rangeOptions.length - 1]!;
    const selectedPriceSeries = slicePriceSeries(priceSeries, selectedRange);
    const selectedTechnical = filterTechnicalSeries(technical, selectedPriceSeries.bars);
    return (
      <ChartFrame
        title="价格走势与技术结构"
        status="ready"
        asOf={priceSeries.asOf}
        sourceTier={priceSeries.sourceTier}
        degradedNote={mixedNote ?? (degraded ? DEGRADED_NOTE : undefined)}
        actions={onAsk ? (
          <button
            type="button"
            onClick={() => onAsk('MARKET_SIGNALS')}
            className="inline-flex items-center gap-1 text-[11px] text-[var(--color-accent)] hover:underline"
          >
            <MessageSquareText className="h-3 w-3" aria-hidden />
            询问此图
          </button>
        ) : null}
        ariaSummary={`近 ${priceSeries.bars.length} 根 K 线，含成交量与均线；支撑 ${technical?.nearestSupport?.toFixed(2) ?? '—'}，阻力 ${technical?.nearestResistance?.toFixed(2) ?? '—'}`}
      >
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-1" role="group" aria-label="行情区间">
            {rangeOptions.map((option) => (
              <button
                key={option}
                type="button"
                aria-pressed={selectedRange === option}
                onClick={() => setRangeDays(option)}
                className={`rounded-[5px] border px-2 py-1 text-[10.5px] font-mono ${selectedRange === option ? 'border-[var(--color-accent)] bg-[var(--color-accent-soft)] text-[var(--color-accent)]' : 'border-[var(--color-border)] text-[var(--color-fg-3)] hover:border-[var(--color-accent)]'}`}
              >
                {option === 365 ? '1Y' : `${option}D`}
              </button>
            ))}
          </div>
          <PriceChart
            priceSeries={selectedPriceSeries}
            technical={selectedTechnical}
            market={market}
            corporateActions={corporateActions}
            onAnnotationClick={() => onAsk?.('MARKET_SIGNALS')}
          />
        </div>
      </ChartFrame>
    );
  }

  return null;
}

const FOCUS_RANGE_DAYS: Record<FocusWindow, 30 | 90 | 365> = {
  '30D': 30,
  '90D': 90,
  '1Y': 365,
  '3Y': 365,
};

const RANGE_OPTIONS = [30, 90, 365] as const;

function availableRanges(priceSeries: ChartPriceSeries): Array<(typeof RANGE_OPTIONS)[number]> {
  const first = Date.parse(`${priceSeries.bars[0]?.t ?? priceSeries.asOf}T00:00:00Z`);
  const last = Date.parse(`${priceSeries.asOf}T00:00:00Z`);
  const spanDays = Number.isFinite(first) && Number.isFinite(last)
    ? Math.floor((last - first) / 86_400_000) + 1
    : 0;
  const options = RANGE_OPTIONS.filter((days) => days <= spanDays);
  return options.length > 0 ? [...options] : [RANGE_OPTIONS[0]];
}

function slicePriceSeries(priceSeries: ChartPriceSeries, days: number): ChartPriceSeries {
  const end = Date.parse(`${priceSeries.asOf}T00:00:00Z`);
  const cutoff = end - days * 86_400_000;
  const bars = priceSeries.bars.filter((bar) => Date.parse(`${bar.t}T00:00:00Z`) >= cutoff);
  const selected = bars.length > 0 ? bars : priceSeries.bars.slice(-1);
  return { ...priceSeries, bars: selected, asOf: selected.at(-1)?.t ?? priceSeries.asOf };
}

function filterTechnicalSeries(
  technical: TechnicalForChart | null | undefined,
  bars: ChartPriceSeries['bars'],
): TechnicalForChart | null | undefined {
  if (!technical?.series) return technical;
  const dates = new Set(bars.map((bar) => bar.t));
  return {
    ...technical,
    series: Object.fromEntries(
      (['sma20', 'sma50', 'sma200'] as const).map((key) => [
        key,
        technical.series?.[key]?.filter((point) => dates.has(point.t)) ?? [],
      ]),
    ),
  };
}

function latestValuationDate(
  series: Array<{ period?: string; fiscalYearEnd?: string }>,
): string | null {
  const dates = series
    .map((point) => point.fiscalYearEnd ?? point.period)
    .filter((value): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value))
    .sort();
  return dates.at(-1) ?? null;
}
