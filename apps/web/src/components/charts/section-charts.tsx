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

import type { SectionType, ChartEvidenceResponse } from '@bourse/shared-types';
import { ChartFrame } from './chart-frame';
import { PercentileBand } from './primitives/percentile-band';
import { ScenarioRangeBar, type ScenarioRange } from './primitives/range-bar';
import { RiskMatrix, type RiskItem } from './primitives/risk-matrix';
import { ComboBarLine, type PeriodTrend } from './primitives/combo-bar-line';

interface ValuationShape {
  peHistorySeries?: Array<{ period: string; pe: number }> | null;
  pe5yHigh?: number | null;
  pe5yLow?: number | null;
  pe5yMedian?: number | null;
  pe5yPercentile?: number | null;
  impliedGrowthRate?: number | null;
  baseCurrency?: string | null;
}

export function SectionCharts({
  sectionType,
  structuredJson,
  evidence,
}: {
  sectionType: SectionType;
  structuredJson?: Record<string, unknown> | null;
  evidence?: { status: string; data?: ChartEvidenceResponse } | null;
}) {
  const chartFacts = evidence?.status === 'ready' ? evidence.data?.chartFacts : undefined;
  const valuation = chartFacts?.valuation as ValuationShape | null | undefined;
  const quote = chartFacts?.quote ?? null;

  if (sectionType === 'VALUATION_SCENARIOS') {
    const series = valuation?.peHistorySeries ?? [];
    const showC2 = series.length >= 3; // I11 gate

    const scenarios = (structuredJson?.scenarios as ScenarioRange[] | undefined) ?? [];
    const price = quote?.price;
    const showC3 = scenarios.some((s) => s.valueRange) && typeof price === 'number';

    return (
      <div className="space-y-3">
        {valuation ? (
          showC2 ? (
            <ChartFrame
              title="PE 历史 · 5 年分位带"
              status="ready"
              asOf={null}
              sourceTier={evidence?.data?.provenance.financials ?? null}
              ariaSummary={`PE 历史 ${series.length} 个财年点位，当前 5 年分位 ${
                valuation.pe5yPercentile != null ? Math.round(valuation.pe5yPercentile) : '—'
              }%`}
            >
              <PercentileBand
                series={series}
                currentPe={series.length && quote?.price ? undefined : null}
                percentile={valuation.pe5yPercentile}
                high={valuation.pe5yHigh}
                median={valuation.pe5yMedian}
                low={valuation.pe5yLow}
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
        ) : null}

        {showC3 ? (
          <ChartFrame
            title="情景价值区间"
            status="ready"
            asOf={quote?.asOf ?? null}
            sourceTier={evidence?.data?.provenance.quote ?? null}
            ariaSummary={`熊基准牛三档价值区间对比当前价 ${price!.toFixed(1)}`}
          >
            <ScenarioRangeBar
              scenarios={scenarios}
              currentPrice={price!}
              currency={scenarios.find((s) => s.valueRange)?.valueRange?.currency ?? quote?.currency ?? ''}
              impliedGrowth={valuation?.impliedGrowthRate ?? null}
            />
          </ChartFrame>
        ) : null}
      </div>
    );
  }

  if (sectionType === 'RISK_REGISTER') {
    const risks = (structuredJson?.risks as RiskItem[] | undefined) ?? [];
    if (!risks.length) return null;
    return (
      <ChartFrame
        title="风险矩阵"
        status="ready"
        ariaSummary={`${risks.length} 项风险按概率与影响分布，点击编号查看机制与监控指标`}
      >
        <RiskMatrix risks={risks} />
      </ChartFrame>
    );
  }

  if (sectionType === 'COMPANY_QUALITY') {
    const trends =
      (chartFacts?.ratios?.periodTrends as PeriodTrend[] | undefined) ?? [];
    if (!trends.length) return null;
    return (
      <ChartFrame
        title="财务趋势"
        status="ready"
        sourceTier={evidence?.data?.provenance.financials ?? null}
        ariaSummary={`营收与净利率趋势，共 ${trends.length} 期`}
      >
        <ComboBarLine trends={trends} />
      </ChartFrame>
    );
  }

  return null;
}
