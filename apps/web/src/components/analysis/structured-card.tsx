'use client';

import { SectionTag } from '@/components/ui';
import { cn } from '@/lib/utils';
import { SignalBadge } from './signal-badge';

/** Generic card to render structuredJson based on section type */
export function StructuredCard({
  sectionType,
  data,
  className,
}: {
  sectionType: string;
  data: any;
  className?: string;
}) {
  if (!data) return null;

  return (
    <div className={cn('space-y-3', className)}>
      {data.conclusion && (
        <Box title="结论">
          <div className="flex items-center gap-2">
            <SignalBadge
              signal={data.conclusion.signal}
              confidence={data.conclusion.confidence}
            />
          </div>
          <p className="mt-2 text-[13.5px] m-0">{data.conclusion.oneLiner}</p>
        </Box>
      )}

      {sectionType === 'VALUATION' && <ValuationCards data={data} />}
      {sectionType === 'RISK' && <RiskCards data={data} />}
      {sectionType === 'SCENARIO' && <ScenarioCards data={data} />}
      {sectionType === 'FUNDAMENTAL' && <FundamentalCards data={data} />}
      {sectionType === 'GOVERNANCE' && <GovernanceCards data={data} />}
      {sectionType === 'INDUSTRY' && <IndustryCards data={data} />}
      {sectionType === 'TECHNICAL' && <TechnicalCards data={data} />}
      {sectionType === 'SENTIMENT' && <SentimentCards data={data} />}
      {sectionType === 'PORTFOLIO' && <PortfolioCards data={data} />}

      {data.dataAvailability?.missingFields?.length > 0 && (
        <Box title="数据缺失说明">
          <p className="text-[12px] text-[var(--color-fg-2)] m-0">
            {data.dataAvailability.reason}
          </p>
          <ul className="mt-1.5 m-0 pl-0 list-none text-[12px] text-[var(--color-fg-2)]">
            {data.dataAvailability.missingFields.map((f: string, i: number) => (
              <li key={i}>· {f}</li>
            ))}
          </ul>
        </Box>
      )}

      {data.disclaimer && (
        <p className="text-[11px] text-[var(--color-fg-3)] m-0">
          {data.disclaimer}
        </p>
      )}
    </div>
  );
}

// Internal box wrapper — distinct from UI primitive Card to keep the
// section-card-list tighter (smaller header, less padding).
function Box({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-bg)]">
      <div className="px-4 py-2.5 border-b border-[var(--color-border-soft)]">
        <SectionTag>{title}</SectionTag>
      </div>
      <div className="px-4 py-3">{children}</div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: any }) {
  return (
    <div>
      <span className="text-[11px] text-[var(--color-fg-3)] uppercase tracking-[0.06em] font-mono">
        {label}
      </span>
      <p className="font-mono text-[13px] font-medium m-0 mt-0.5 text-[var(--color-fg)]">
        {value != null ? String(value) : '—'}
      </p>
    </div>
  );
}

function ValuationLevel({ level }: { level: string }) {
  const colorMap: Record<string, string> = {
    CHEAP: 'text-[var(--color-accent-600)]',
    FAIR: 'text-[var(--color-fg-2)]',
    EXPENSIVE: 'text-[var(--color-warn)]',
    VERY_EXPENSIVE: 'text-[var(--color-danger)]',
  };
  const labels: Record<string, string> = {
    CHEAP: '低估',
    FAIR: '合理',
    EXPENSIVE: '偏贵',
    VERY_EXPENSIVE: '昂贵',
  };
  return (
    <span className={cn('text-[14px] font-medium', colorMap[level])}>
      {labels[level] || level}
    </span>
  );
}

function SeverityDot({
  severity,
  showLabel,
}: {
  severity: string;
  showLabel?: boolean;
}) {
  const colorMap: Record<string, string> = {
    HIGH: 'bg-[var(--color-danger)]',
    MEDIUM: 'bg-[var(--color-warn)]',
    LOW: 'bg-[var(--color-fg-3)]',
  };
  const labels: Record<string, string> = {
    HIGH: '高风险',
    MEDIUM: '中风险',
    LOW: '低风险',
  };
  return (
    <span className="flex items-center gap-1.5">
      <span
        className={cn('inline-block h-2 w-2 rounded-full', colorMap[severity])}
      />
      {showLabel && (
        <span className="text-[13px] font-medium">
          {labels[severity] || severity}
        </span>
      )}
    </span>
  );
}

function MatchIndicator({ label, match }: { label: string; match: string }) {
  const colorMap: Record<string, string> = {
    SUITABLE: 'text-[var(--color-accent-600)]',
    MODERATE_MATCH: 'text-[var(--color-warn)]',
    MISMATCH: 'text-[var(--color-danger)]',
  };
  const labels: Record<string, string> = {
    SUITABLE: '匹配',
    MODERATE_MATCH: '一般',
    MISMATCH: '不匹配',
  };
  return (
    <div className="text-center">
      <span className="text-[11px] text-[var(--color-fg-3)] uppercase tracking-[0.06em] font-mono">
        {label}
      </span>
      <p className={cn('m-0 mt-1 text-[13px] font-medium', colorMap[match])}>
        {labels[match] || match}
      </p>
    </div>
  );
}

export function ValuationCards({ data }: { data: any }) {
  return (
    <>
      {data.level && (
        <Box title="估值水平">
          <ValuationLevel level={data.level} />
          {data.currentPrice != null && (
            <p className="mt-2 m-0 text-[13px]">
              当前价格:{' '}
              <span className="font-mono font-medium">{data.currentPrice}</span>{' '}
              <span className="text-[var(--color-fg-2)]">{data.currency}</span>
            </p>
          )}
        </Box>
      )}
      {data.dcf && (
        <Box title="DCF 估值">
          <div className="grid grid-cols-2 gap-3">
            <Metric label="公允价值" value={data.dcf.fairValue} />
            <Metric
              label="上行空间"
              value={
                data.dcf.upside != null
                  ? `${(data.dcf.upside * 100).toFixed(1)}%`
                  : null
              }
            />
            <Metric
              label="WACC"
              value={
                data.dcf.wacc != null
                  ? `${(data.dcf.wacc * 100).toFixed(1)}%`
                  : null
              }
            />
            <Metric
              label="终端增长率"
              value={
                data.dcf.terminalGrowthRate != null
                  ? `${(data.dcf.terminalGrowthRate * 100).toFixed(1)}%`
                  : null
              }
            />
          </div>
        </Box>
      )}
      {data.relativeValuation && (
        <Box title="相对估值">
          <div className="grid grid-cols-2 gap-3">
            <Metric label="PE" value={data.relativeValuation.peRatio} />
            <Metric label="同行 PE" value={data.relativeValuation.peerMedianPe} />
            <Metric label="PS" value={data.relativeValuation.psRatio} />
            <Metric label="EV/EBITDA" value={data.relativeValuation.evEbitda} />
          </div>
          {data.relativeValuation.premiumDiscount && (
            <p className="mt-2 m-0 text-[12px] text-[var(--color-fg-2)]">
              {data.relativeValuation.premiumDiscount}
            </p>
          )}
        </Box>
      )}
    </>
  );
}

export function RiskCards({ data }: { data: any }) {
  const renderRiskList = (risks: any[], label: string) => {
    if (!risks?.length) return null;
    return (
      <Box title={label}>
        <ul className="m-0 pl-0 list-none space-y-2">
          {risks.map((r: any, i: number) => (
            <li key={i} className="flex items-start gap-2 text-[13px]">
              <SeverityDot severity={r.severity} />
              <div>
                <span className="font-medium">{r.risk}</span>
                <p className="text-[12px] text-[var(--color-fg-2)] m-0 mt-0.5">
                  {r.description}
                </p>
              </div>
            </li>
          ))}
        </ul>
      </Box>
    );
  };

  return (
    <>
      {data.overallRiskLevel && (
        <Box title="综合风险评级">
          <SeverityDot severity={data.overallRiskLevel} showLabel />
        </Box>
      )}
      {renderRiskList(data.companyRisks, '公司风险')}
      {renderRiskList(data.macroRisks, '宏观风险')}
      {renderRiskList(data.regulatoryRisks, '监管风险')}
    </>
  );
}

export function ScenarioCards({ data }: { data: any }) {
  const scenarios = [
    {
      key: 'bull',
      label: '牛市',
      color: 'text-[var(--color-accent-600)]',
    },
    { key: 'base', label: '基本', color: 'text-[var(--color-fg)]' },
    { key: 'bear', label: '熊市', color: 'text-[var(--color-warn)]' },
  ];

  return (
    <Box title="情景分析">
      <div className="space-y-3">
        {scenarios.map(({ key, label, color }) => {
          const s = data[key];
          if (!s) return null;
          return (
            <div
              key={key}
              className="rounded-[8px] bg-[var(--color-surface-hover)] p-3"
            >
              <div className="flex items-center justify-between">
                <span className={cn('text-[13px] font-medium', color)}>
                  {label}
                </span>
                <div className="flex items-center gap-2 text-[13px]">
                  {s.targetPrice != null && (
                    <span className="font-mono font-medium">
                      {s.targetPrice}
                    </span>
                  )}
                  {s.probability != null && (
                    <span className="text-[var(--color-fg-2)]">
                      ({(s.probability * 100).toFixed(0)}%)
                    </span>
                  )}
                </div>
              </div>
              <p className="mt-1 m-0 text-[12px] text-[var(--color-fg-2)]">
                {s.rationale}
              </p>
            </div>
          );
        })}
      </div>
    </Box>
  );
}

function FundamentalCards({ data }: { data: any }) {
  return (
    <>
      {data.businessModel && (
        <Box title="商业模式">
          <p className="text-[13px] m-0">{data.businessModel.description}</p>
          {data.businessModel.moat && (
            <p className="mt-2 m-0 text-[13px]">
              <span className="font-medium">护城河：</span>
              {data.businessModel.moat}{' '}
              <span className="text-[11.5px] text-[var(--color-fg-2)]">
                ({data.businessModel.moatStrength})
              </span>
            </p>
          )}
        </Box>
      )}
      {data.financialTrends && (
        <Box title="财务趋势">
          <div className="grid grid-cols-2 gap-3">
            <Metric
              label="3 年收入增长"
              value={
                data.financialTrends.revenueGrowth3Y != null
                  ? `${(data.financialTrends.revenueGrowth3Y * 100).toFixed(1)}%`
                  : null
              }
            />
            <Metric
              label="净利润率趋势"
              value={data.financialTrends.netMarginTrend}
            />
            <Metric
              label="ROE 趋势"
              value={data.financialTrends.roeTrend}
            />
            <Metric
              label="负债率"
              value={data.financialTrends.debtToEquity}
            />
          </div>
        </Box>
      )}
    </>
  );
}

function IndustryCards({ data }: { data: any }) {
  return (
    <>
      {data.industryOverview && (
        <Box title="行业概览">
          <div className="grid grid-cols-2 gap-3">
            <Metric label="行业" value={data.industryOverview.name} />
            <Metric
              label="市场规模"
              value={data.industryOverview.marketSize}
            />
            <Metric
              label="增长率"
              value={data.industryOverview.growthRate}
            />
            <Metric label="阶段" value={data.industryOverview.stage} />
          </div>
        </Box>
      )}
      {data.competitors?.length > 0 && (
        <Box title="竞争对手">
          <ul className="m-0 pl-0 list-none space-y-1.5 text-[13px]">
            {data.competitors.slice(0, 5).map((c: any, i: number) => (
              <li key={i}>
                <span className="font-medium">{c.name}</span>
                {c.marketShare && (
                  <span className="ml-1 text-[11.5px] text-[var(--color-fg-2)]">
                    ({c.marketShare})
                  </span>
                )}
              </li>
            ))}
          </ul>
        </Box>
      )}
    </>
  );
}

function TechnicalCards({ data }: { data: any }) {
  return (
    <>
      <Box title="技术信号">
        <div className="grid grid-cols-2 gap-3">
          <Metric label="趋势" value={data.trend} />
          <Metric label="成交量" value={data.volumeTrend} />
        </div>
      </Box>
      {data.indicators?.length > 0 && (
        <Box title="技术指标">
          <ul className="m-0 pl-0 list-none space-y-1.5 text-[13px]">
            {data.indicators.map((ind: any, i: number) => (
              <li key={i} className="flex items-center justify-between">
                <span>{ind.name}</span>
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[11.5px]">{ind.value}</span>
                  <SignalBadge signal={ind.signal} />
                </div>
              </li>
            ))}
          </ul>
        </Box>
      )}
    </>
  );
}

function SentimentCards({ data }: { data: any }) {
  return (
    <>
      {data.analystConsensus && (
        <Box title="分析师共识">
          <div className="grid grid-cols-2 gap-3">
            <Metric label="评级" value={data.analystConsensus.rating} />
            <Metric label="目标价" value={data.analystConsensus.targetPrice} />
            <Metric
              label="分析师数量"
              value={data.analystConsensus.numberOfAnalysts}
            />
          </div>
        </Box>
      )}
      {data.institutionalActivity && (
        <Box title="机构动向">
          <Metric label="趋势" value={data.institutionalActivity.trend} />
        </Box>
      )}
    </>
  );
}

function GovernanceCards({ data }: { data: any }) {
  return (
    <>
      {data.governanceRating && (
        <Box title="治理质量评级">
          <p className="text-[14px] font-medium m-0">
            {data.governanceRating}
          </p>
        </Box>
      )}
      {data.ownership && (
        <Box title="股权结构">
          <div className="space-y-2">
            {data.ownership.controllingShareholder && (
              <Metric
                label="实控人"
                value={data.ownership.controllingShareholder}
              />
            )}
            {data.ownership.topShareholderPct != null && (
              <Metric
                label="第一大股东持股"
                value={`${(data.ownership.topShareholderPct * 100).toFixed(1)}%`}
              />
            )}
            {data.ownership.insiderHoldingPct != null && (
              <Metric
                label="管理层持股"
                value={`${(data.ownership.insiderHoldingPct * 100).toFixed(1)}%`}
              />
            )}
            {data.ownership.pledgeRatio != null && (
              <Metric
                label="质押比例"
                value={`${(data.ownership.pledgeRatio * 100).toFixed(1)}%`}
              />
            )}
          </div>
        </Box>
      )}
      {data.managementIncentive && (
        <Box title="管理层激励">
          <p className="text-[13px] m-0">{data.managementIncentive.summary}</p>
          {data.managementIncentive.recentActivity && (
            <p className="mt-1 m-0 text-[12px] text-[var(--color-fg-2)]">
              近期变动：{data.managementIncentive.recentActivity}
            </p>
          )}
        </Box>
      )}
      {data.roicTrend && (
        <Box title="ROIC 趋势 · 近 5 年">
          {Array.isArray(data.roicTrend.series) && (
            <div className="grid grid-cols-5 gap-2">
              {data.roicTrend.series.map((y: any, i: number) => (
                <Metric
                  key={i}
                  label={String(y.year)}
                  value={
                    y.value != null ? `${(y.value * 100).toFixed(1)}%` : null
                  }
                />
              ))}
            </div>
          )}
          {data.roicTrend.peerComparison && (
            <p className="mt-2 m-0 text-[12px] text-[var(--color-fg-2)]">
              同业对比：{data.roicTrend.peerComparison}
            </p>
          )}
        </Box>
      )}
      {data.capitalAllocation && (
        <Box title="资本配置历史 · 近 5 年">
          <div className="grid grid-cols-2 gap-3">
            {data.capitalAllocation.buybackTotalPctOfNetIncome != null && (
              <Metric
                label="回购 / 净利润"
                value={`${(data.capitalAllocation.buybackTotalPctOfNetIncome * 100).toFixed(0)}%`}
              />
            )}
            {data.capitalAllocation.dividendPayoutPctOfFCF != null && (
              <Metric
                label="分红 / 自由现金流"
                value={`${(data.capitalAllocation.dividendPayoutPctOfFCF * 100).toFixed(0)}%`}
              />
            )}
            {data.capitalAllocation.capexPctOfRevenue != null && (
              <Metric
                label="资本开支 / 收入"
                value={`${(data.capitalAllocation.capexPctOfRevenue * 100).toFixed(0)}%`}
              />
            )}
            {data.capitalAllocation.maTotalUsd != null && (
              <Metric
                label="累计并购金额"
                value={data.capitalAllocation.maTotalUsd}
              />
            )}
          </div>
          {data.capitalAllocation.commentary && (
            <p className="mt-2 m-0 text-[12px] text-[var(--color-fg-2)]">
              {data.capitalAllocation.commentary}
            </p>
          )}
        </Box>
      )}
    </>
  );
}

function PortfolioCards({ data }: { data: any }) {
  return (
    <>
      {data.suitability && (
        <Box title="适配评估">
          <div className="grid grid-cols-3 gap-2">
            <MatchIndicator label="风险" match={data.suitability.riskMatch} />
            <MatchIndicator
              label="期限"
              match={data.suitability.horizonMatch}
            />
            <MatchIndicator label="风格" match={data.suitability.styleMatch} />
          </div>
        </Box>
      )}
      {data.positionSizing && (
        <Box title="仓位建议">
          <p className="text-[14px] font-medium m-0">
            {data.positionSizing.suggestedAllocation}
          </p>
          <p className="mt-1 m-0 text-[12px] text-[var(--color-fg-2)]">
            {data.positionSizing.rationale}
          </p>
        </Box>
      )}
    </>
  );
}
