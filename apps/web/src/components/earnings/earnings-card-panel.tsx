'use client';

import { useState } from 'react';

import {
  AlertCircle,
  Check,
  ChevronDown,
  Clock3,
  ExternalLink,
  FileSearch,
  History,
  Loader2,
  MessageSquareText,
  RotateCcw,
  ShieldCheck,
  TriangleAlert,
} from 'lucide-react';
import type {
  EarningsCardDto,
  EarningsGenerationRunDto,
  EarningsMetricFactDto,
  LatestEarningsResponseDto,
} from '@bourse/shared-types';
import { Button, Card, Pill } from '@/components/ui';
import { cn } from '@/lib/utils';

const METRIC_LABELS: Record<string, string> = {
  revenue: '营业收入',
  costOfRevenue: '营业成本',
  grossProfit: '毛利润',
  operatingIncome: '营业利润',
  netIncome: '净利润',
  netIncomeAttrib: '归母净利润',
  epsBasic: '基本每股收益',
  epsDiluted: '稀释每股收益',
  grossMargin: '毛利率',
  operatingMargin: '营业利润率',
  netMargin: '净利率',
  operatingCashFlow: '经营现金流',
  capitalExpenditures: '资本开支',
  freeCashFlow: '自由现金流',
  totalAssets: '总资产',
  totalLiabilities: '总负债',
  totalEquity: '股东权益',
  cashAndCashEquivalents: '现金及等价物',
};

const STAGE_LABELS: Record<string, string> = {
  DISCOVER: '查找最新公告',
  FETCH: '获取公告正文',
  DERIVE: '解析公告内容',
  EXTRACT: '提取财务数字',
  CHECK: '执行一致性检查',
  RECONCILE: '与结构化三表对账',
  INTERPRET: '整理管理层说法',
  PERSIST: '保存财报卡片',
  DONE: '已完成',
};

export function EarningsCardPanel({
  response,
  generation,
  loading,
  error,
  onStart,
  onRetry,
  onAsk,
  history = [],
  historyLoading = false,
  onLoadHistory,
}: {
  response: LatestEarningsResponseDto | null;
  generation: EarningsGenerationRunDto | null;
  loading: boolean;
  error: string | null;
  onStart: () => void;
  onRetry: () => void;
  onAsk: () => void;
  history?: EarningsCardDto[];
  historyLoading?: boolean;
  onLoadHistory?: () => void;
}) {
  if (!response && loading) return <EarningsSkeleton />;
  if (response && !response.supported) {
    if (response.reason === 'FEATURE_DISABLED') return null;
    return (
      <div className="mb-6 flex items-start gap-3 border-y border-[var(--color-border-soft)] px-1 py-3 text-[12px] text-[var(--color-fg-2)]">
        <FileSearch className="mt-0.5 h-3.5 w-3.5 shrink-0" strokeWidth={1.5} />
        <p className="m-0 leading-5">当前市场的财报速读尚未开放。</p>
      </div>
    );
  }
  if (response?.reason === 'NO_ELIGIBLE_FILING') {
    return (
      <div className="mb-6 flex items-start gap-3 border-y border-[var(--color-border-soft)] px-1 py-3 text-[12px] text-[var(--color-fg-2)]">
        <FileSearch className="mt-0.5 h-3.5 w-3.5 shrink-0" strokeWidth={1.5} />
        <p className="m-0 leading-5">暂未发现可生成速读卡的财报公告。</p>
      </div>
    );
  }

  if (generation && ['QUEUED', 'RUNNING'].includes(generation.status) && !response?.card) {
    return <GeneratingState generation={generation} />;
  }

  if (generation && ['FAILED', 'BUDGET_EXHAUSTED'].includes(generation.status) && !response?.card) {
    return (
      <Card className="mb-6">
        <div className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center">
          <div className="flex min-w-0 flex-1 items-start gap-3">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-danger)]" strokeWidth={1.6} />
            <div>
              <p className="m-0 text-[13px] font-medium">财报速读暂未生成</p>
              <p className="m-0 mt-1 text-[12px] leading-5 text-[var(--color-fg-2)]">
                {generation.status === 'BUDGET_EXHAUSTED'
                  ? '今日公共卡生成预算已用完，稍后可重新尝试。'
                  : readableError(generation.errorCode, generation.errorMessage ?? error)}
              </p>
            </div>
          </div>
          {generation.retryable && (
            <Button size="sm" onClick={onRetry} disabled={loading}>
              {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
              重试
            </Button>
          )}
        </div>
      </Card>
    );
  }

  if (response?.card) {
    return (
      <EarningsCard
        card={response.card}
        onAsk={onAsk}
        history={history}
        historyLoading={historyLoading}
        onLoadHistory={onLoadHistory}
      />
    );
  }

  if (error && response?.reason !== 'NO_ELIGIBLE_FILING') {
    return (
      <div className="mb-6 flex items-center justify-between gap-3 rounded-[var(--radius-btn)] border border-[var(--color-warn-line)] bg-[var(--color-warn-soft)] px-4 py-3">
        <p className="m-0 text-[12.5px] text-[var(--color-fg)]">{error}</p>
        <Button size="sm" onClick={onStart} disabled={loading}>
          <RotateCcw className="h-3.5 w-3.5" />
          再试一次
        </Button>
      </div>
    );
  }

  return null;
}

function EarningsCard({
  card,
  onAsk,
  history,
  historyLoading,
  onLoadHistory,
}: {
  card: EarningsCardDto;
  onAsk: () => void;
  history: EarningsCardDto[];
  historyLoading: boolean;
  onLoadHistory?: () => void;
}) {
  const status = aggregateStatus(card);
  const structuredOnly = card.statusSummary.total > 0
    && card.statusSummary.structuredOnly === card.statusSummary.total;
  const [timelineOpen, setTimelineOpen] = useState(false);
  return (
    <Card className="mb-6 min-w-0 w-full" data-testid="earnings-card">
      <div className="flex min-w-0 flex-col gap-3 border-b border-[var(--color-border-soft)] px-4 py-4 sm:flex-row sm:items-start sm:justify-between sm:px-5">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="m-0 basis-full text-wrap-balance text-[15px] font-semibold text-[var(--color-fg)] sm:basis-auto">
              {periodLabel(card)} · {formLabel(card.filing.formType)}
            </h2>
            <Pill variant={status.variant} dot>{status.label}</Pill>
            {card.filing.unaudited && <Pill variant="neutral">未经审计</Pill>}
            {card.revisionStatus === 'PARTIAL' && <Pill variant="neutral">仅数字</Pill>}
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-[var(--color-fg-3)]">
            <span>{formatDateTime(card.filing.publishedAt)} 披露</span>
            <span>revision {card.revisionNo}</span>
            <span>{card.filing.provider}</span>
          </div>
        </div>
        <a
          href={card.filing.sourceUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex h-7 shrink-0 items-center gap-1.5 self-start rounded-[var(--radius-btn)] px-2 text-[12px] text-[var(--color-fg-2)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-fg)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent)]"
          title="打开公告原文"
        >
          <ExternalLink className="h-3.5 w-3.5" strokeWidth={1.5} />
          公告原文
        </a>
      </div>
      {card.supportingFilings && card.supportingFilings.length > 0 && (
        <div className="flex flex-wrap gap-x-3 gap-y-1 border-b border-[var(--color-border-soft)] px-5 py-2 text-[10.5px] text-[var(--color-fg-3)]">
          <span>关联来源</span>
          {card.supportingFilings.map((filing) => (
            <a
              key={`${filing.filingId ?? filing.sourceUrl}-${filing.relationType ?? 'supplement'}`}
              href={filing.sourceUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 hover:text-[var(--color-fg)]"
            >
              {formLabel(filing.formType)} · {filing.relationType === 'CORRECTS' ? '更正' : filing.relationType === 'SUPERSEDES' ? '后续版本' : '补充'}
              <ExternalLink className="h-3 w-3" strokeWidth={1.5} />
            </a>
          ))}
        </div>
      )}

      <div className="divide-y divide-[var(--color-border-soft)]">
        <section aria-labelledby="earnings-metrics-title" className="px-4 py-4 sm:px-5">
          <div className="mb-2.5 flex items-center justify-between gap-3">
            <h3 id="earnings-metrics-title" className="m-0 text-[12px] font-medium text-[var(--color-fg-2)]">数字一览</h3>
            <span className="text-[11px] text-[var(--color-fg-3)]">
              {structuredOnly
                ? `${card.statusSummary.total} 项原文待核`
                : `${card.statusSummary.reconciled}/${card.statusSummary.total} 已对账`}
            </span>
          </div>
          <div className="divide-y divide-[var(--color-border-soft)] border-y border-[var(--color-border-soft)]">
            {card.facts.map((fact) => <MetricRow key={fact.id} fact={fact} />)}
          </div>
          {card.omittedFactCount > 0 && (
            <div className="mt-3 flex items-start gap-2 text-[11.5px] leading-5 text-[var(--color-fg-2)]">
              <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--color-warn)]" strokeWidth={1.5} />
              {card.omittedFactCount} 项数字未通过一致性检查，未予展示
            </div>
          )}
        </section>

        {card.managementClaims.length > 0 && (
          <section aria-labelledby="earnings-claims-title" className="px-5 py-4">
            <h3 id="earnings-claims-title" className="m-0 mb-3 text-[12px] font-medium text-[var(--color-fg-2)]">管理层怎么说</h3>
            <div className="space-y-2.5">
              {card.managementClaims.map((claim, index) => (
                <details key={claim.id} className="group">
                  <summary className="flex cursor-pointer list-none items-start gap-2 text-[13px] leading-5 text-[var(--color-fg)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent)]">
                    <span className="mt-[2px] font-mono text-[10px] text-[var(--color-fg-3)]">{index + 1}</span>
                    <span className="min-w-0 flex-1">{claim.text}</span>
                    <ChevronDown className="mt-1 h-3.5 w-3.5 shrink-0 text-[var(--color-fg-3)] transition-transform duration-150 group-open:rotate-180" />
                  </summary>
                  <blockquote className="mb-0 ml-5 mt-2 max-w-[72ch] border border-[var(--color-border-soft)] bg-[var(--color-surface-2)] px-3 py-2 text-[11.5px] leading-5 text-[var(--color-fg-2)]">
                    “{claim.source.quote}”
                    <footer className="mt-1 font-mono text-[10px] text-[var(--color-fg-3)]">
                      {claim.source.page ? `第 ${claim.source.page} 页` : '公告原文'}
                    </footer>
                  </blockquote>
                </details>
              ))}
            </div>
          </section>
        )}
      </div>

      <div className="flex min-w-0 flex-col gap-2 border-t border-[var(--color-border-soft)] bg-[var(--color-surface-2)] px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-5">
        <div className="flex min-w-0 items-start gap-2 text-[11px] leading-5 text-[var(--color-fg-2)] sm:items-center">
          {structuredOnly
            ? <Clock3 className="h-3.5 w-3.5 text-[var(--color-info)]" strokeWidth={1.5} />
            : <ShieldCheck className="h-3.5 w-3.5 text-[var(--color-accent)]" strokeWidth={1.5} />}
          {structuredOnly
            ? '结构化数据 · 原文待核；数据截至日期见逐项来源'
            : '自动一致性检查不是审计；冲突项保留双来源'}
        </div>
        <Button className="min-h-11 w-full sm:min-h-7 sm:w-auto" variant="quiet" size="sm" onClick={onAsk}>
          <MessageSquareText className="h-3.5 w-3.5" strokeWidth={1.5} />
          追问这份财报
        </Button>
      </div>
      <div className="border-t border-[var(--color-border-soft)] px-4 py-2.5 sm:px-5">
        <button
          type="button"
          aria-expanded={timelineOpen}
          onClick={() => {
            setTimelineOpen((open) => !open);
            if (!timelineOpen) onLoadHistory?.();
          }}
          className="inline-flex min-h-11 items-center gap-2 rounded-[var(--radius-btn)] px-1.5 text-[11.5px] text-[var(--color-fg-2)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-fg)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent)] sm:min-h-8"
        >
          <History className="h-3.5 w-3.5" strokeWidth={1.5} />
          版本与历史
          <span className="font-mono text-[10px] text-[var(--color-fg-3)]">
            {history.length > 0 ? history.length : '展开'}
          </span>
        </button>
        {timelineOpen && (
          <EarningsTimeline card={card} history={history} loading={historyLoading} />
        )}
      </div>
    </Card>
  );
}

function EarningsTimeline({
  card,
  history,
  loading,
}: {
  card: EarningsCardDto;
  history: EarningsCardDto[];
  loading: boolean;
}) {
  if (loading) {
    return <div className="mt-2 h-8 animate-pulse rounded bg-[var(--color-surface-2)] motion-reduce:animate-none" aria-label="正在加载版本历史" />;
  }
  if (history.length === 0) {
    return <p className="m-0 mt-2 text-[11.5px] leading-5 text-[var(--color-fg-3)]">暂时没有可展示的历史版本。</p>;
  }
  return (
    <ol className="mt-2 divide-y divide-[var(--color-border-soft)] border-t border-[var(--color-border-soft)]">
      {history.map((revision) => {
        const isCurrent = revision.revisionId === card.revisionId;
        return (
          <li key={revision.revisionId} className="py-2.5 text-[11.5px]">
            <details>
              <summary className="flex cursor-pointer list-none items-start gap-3 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent)]">
            <span className={cn('mt-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full border font-mono text-[9px]', isCurrent ? 'border-[var(--color-accent)] text-[var(--color-accent)]' : 'border-[var(--color-border)] text-[var(--color-fg-3)]')}>
              {revision.revisionNo}
            </span>
            <span className="min-w-0 flex-1">
              <span className="font-medium text-[var(--color-fg)]">
                {periodLabel(revision)} · {formLabel(revision.filing.formType)}
              </span>
              <span className="ml-2 text-[var(--color-fg-3)]">
                {isCurrent ? '当前版本' : revision.supersededAt ? '已被后续版本替代' : '历史版本'}
              </span>
              <span className="mt-0.5 block font-mono text-[10px] text-[var(--color-fg-3)]">
                {formatDateTime(revision.filing.publishedAt)} 披露 · {revision.statusSummary.total} 项数字
              </span>
            </span>
                <ChevronDown className="mt-1 h-3.5 w-3.5 shrink-0 text-[var(--color-fg-3)]" />
              </summary>
              <div className="ml-7 mt-2 space-y-1.5 border-l border-[var(--color-border-soft)] pl-3">
                {revision.facts.slice(0, 8).map((fact) => {
                  const change = fact.comparisons.find((comparison) => comparison.kind === 'PREVIOUS_VERSION');
                  return (
                    <div key={fact.id} className="flex flex-wrap items-baseline justify-between gap-x-3 text-[11px]">
                      <span className="text-[var(--color-fg-2)]">{METRIC_LABELS[fact.metricCode] ?? fact.metricCode}</span>
                      <span className="font-mono text-[var(--color-fg)]">
                        {formatMetricValue(fact)}{change ? ` · ${formatComparison(change, fact)}` : ''}
                      </span>
                    </div>
                  );
                })}
              </div>
            </details>
          </li>
        );
      })}
    </ol>
  );
}

function MetricRow({ fact }: { fact: EarningsMetricFactDto }) {
  const state = factState(fact);
  return (
    <details className="group">
      <summary className="grid min-h-[64px] cursor-pointer list-none grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 px-1 py-2.5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent)] sm:min-h-[52px] sm:grid-cols-[minmax(120px,1fr)_minmax(120px,auto)_minmax(110px,auto)_18px] sm:gap-y-0">
        <span className="min-w-0 text-[12.5px] text-[var(--color-fg-2)]">{METRIC_LABELS[fact.metricCode] ?? fact.metricCode}</span>
        <span className="col-span-2 row-start-2 min-w-0 whitespace-normal break-words text-left font-mono text-[13.5px] font-medium tabular-nums text-[var(--color-fg)] sm:col-span-1 sm:row-start-auto">
          {formatMetricValue(fact)}
        </span>
        <span className="col-start-2 row-start-1 flex min-w-0 flex-wrap items-center justify-end gap-2 text-[11px] text-[var(--color-fg-3)] sm:col-start-auto sm:row-start-auto sm:justify-end">
          {fact.comparisons.map((comparison) => (
            <span key={`${comparison.kind}-${comparison.label}`} title={comparison.asOf ? `快照：${formatDateTime(comparison.asOf)}` : undefined}>
              {formatComparison(comparison, fact)}
            </span>
          ))}
          <span className={cn('inline-flex items-center gap-1', state.className)}>
            {state.icon}
            {state.label}
          </span>
        </span>
        <ChevronDown className="hidden h-3.5 w-3.5 text-[var(--color-fg-3)] transition-transform duration-150 group-open:rotate-180 sm:block" />
      </summary>
      <div className="mb-2 ml-1 mr-1 border border-[var(--color-border-soft)] bg-[var(--color-surface-2)] px-3 py-2.5">
        {fact.provenance.kind === 'filingSpan' ? (
          <>
            <p className="m-0 text-[11.5px] leading-5 text-[var(--color-fg-2)]">“{fact.provenance.quote}”</p>
            <p className="m-0 mt-1 font-mono text-[10px] text-[var(--color-fg-3)]">
              {fact.provenance.page ? `第 ${fact.provenance.page} 页 · ` : ''}
              {fact.provenance.provider} · 字符 {fact.provenance.startOffset}–{fact.provenance.endOffset}
            </p>
          </>
        ) : (
          <p className="m-0 font-mono text-[10.5px] leading-5 text-[var(--color-fg-2)]">
            {fact.provenance.provider} · {fact.provenance.fieldPath} · 数据截至 {formatDateTime(fact.provenance.asOf)}
          </p>
        )}
        {fact.reconcileStatus.status === 'conflicted' && (
          <div className="mt-2 grid gap-1 border-t border-[var(--color-border)] pt-2 text-[11.5px] sm:grid-cols-2">
            <span>公告原文：{formatRawValue(fact.reconcileStatus.sourceValue, fact)}</span>
            <span>结构化源：{formatRawValue(fact.reconcileStatus.structuredValue, fact)}</span>
          </div>
        )}
        {fact.reconciliationOverdue && (
          <p className="m-0 mt-2 border-t border-[var(--color-border)] pt-2 text-[11px] leading-5 text-[var(--color-fg-2)]">
            结构化数据源超过 45 天仍未收录该期；当前仅可按公告原文查证。
          </p>
        )}
        {fact.comparisons.filter((comparison) => comparison.sourceQuote).map((comparison) => (
          <blockquote key={`${comparison.kind}-${comparison.asOf ?? ''}`} className="m-0 mt-2 border-t border-[var(--color-border)] pt-2 text-[11px] leading-5 text-[var(--color-fg-2)]">
            {comparison.label}原文：“{comparison.sourceQuote}”
          </blockquote>
        ))}
      </div>
    </details>
  );
}

function GeneratingState({ generation }: { generation: EarningsGenerationRunDto }) {
  return (
    <Card className="mb-6" data-testid="earnings-generating">
      <div className="px-5 py-4">
        <div className="flex items-center gap-3">
          <FileSearch className="h-4 w-4 text-[var(--color-accent)]" strokeWidth={1.5} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-3">
              <p className="m-0 text-[13px] font-medium">正在生成财报速读</p>
              <span className="font-mono text-[10.5px] text-[var(--color-fg-3)]">{STAGE_LABELS[generation.stage] ?? generation.stage}</span>
            </div>
            <div className="mt-2 h-1 overflow-hidden rounded-full bg-[var(--color-border-soft)]">
              <div className="h-full w-2/5 rounded-full bg-[var(--color-accent)] motion-safe:animate-[progress-slide_1.6s_ease-in-out_infinite]" />
            </div>
          </div>
        </div>
      </div>
    </Card>
  );
}

function EarningsSkeleton() {
  return (
    <Card className="mb-6" aria-label="正在加载财报速读">
      <div className="animate-pulse px-5 py-4 motion-reduce:animate-none">
        <div className="h-4 w-48 rounded bg-[var(--color-border-soft)]" />
        <div className="mt-3 h-3 w-72 max-w-full rounded bg-[var(--color-border-soft)]" />
        <div className="mt-5 space-y-3 border-t border-[var(--color-border-soft)] pt-4">
          <div className="h-7 rounded bg-[var(--color-surface-2)]" />
          <div className="h-7 rounded bg-[var(--color-surface-2)]" />
          <div className="h-7 rounded bg-[var(--color-surface-2)]" />
        </div>
      </div>
    </Card>
  );
}

function factState(fact: EarningsMetricFactDto) {
  if (fact.checkStatus === 'structured_only') {
    return { label: '原文待核', className: 'text-[var(--color-info)]', icon: <Clock3 className="h-3 w-3" /> };
  }
  switch (fact.reconcileStatus.status) {
    case 'reconciled':
      return { label: '已对账', className: 'text-[var(--color-accent)]', icon: <Check className="h-3 w-3" /> };
    case 'conflicted':
      return { label: '冲突', className: 'text-[var(--color-danger)]', icon: <TriangleAlert className="h-3 w-3" /> };
    default:
      return { label: '待对账', className: 'text-[var(--color-warn)]', icon: <Clock3 className="h-3 w-3" /> };
  }
}

function aggregateStatus(card: EarningsCardDto): { label: string; variant: 'emerald' | 'warn' | 'danger' | 'blue' } {
  if (card.statusSummary.conflicted > 0) return { label: `${card.statusSummary.conflicted} 项冲突`, variant: 'danger' };
  if (card.statusSummary.structuredOnly > 0) return { label: '原文待核', variant: 'blue' };
  if (card.statusSummary.pending > 0) return { label: `${card.statusSummary.reconciled}/${card.statusSummary.total} 已对账`, variant: 'warn' };
  return { label: '已对账', variant: 'emerald' };
}

function periodLabel(card: EarningsCardDto): string {
  if (card.periodType === 'FY') return `${card.fiscalYear} 年度`;
  if (card.periodType === 'H1') return `${card.fiscalYear} 半年度`;
  return `${card.fiscalYear} ${card.periodType}`;
}

function formLabel(formType: string): string {
  const normalized = formType.toLowerCase();
  if (normalized === 'preview') return '业绩预告';
  if (normalized === 'preliminary') return '业绩快报';
  if (normalized === '8-k') return '业绩公告';
  if (normalized === '10-q') return '季报';
  if (normalized === '10-k') return '年报';
  return formType;
}

function formatMetricValue(fact: EarningsMetricFactDto): string {
  return formatRawValue(fact.normalizedValue ?? fact.value, fact);
}

function formatRawValue(value: EarningsMetricFactDto['value'], fact: EarningsMetricFactDto): string {
  const formatOne = (raw: string) => {
    const number = Number(raw);
    if (!Number.isFinite(number)) return raw;
    if (fact.unit === 'percent') return `${formatNumber(number)}%`;
    if (fact.unit === 'percentage_point') return `${formatNumber(number)}pp`;
    if (fact.unit === 'per_share') return `${fact.currency ?? ''} ${formatNumber(number)}`.trim();
    if (fact.unit !== 'currency') return formatNumber(number);
    const abs = Math.abs(number);
    if (fact.currency === 'USD') {
      if (abs >= 1e9) return `$${formatNumber(number / 1e9)}B`;
      if (abs >= 1e6) return `$${formatNumber(number / 1e6)}M`;
      return `$${formatNumber(number)}`;
    }
    const symbol = fact.currency === 'HKD' ? 'HK$' : '¥';
    if (abs >= 1e8) return `${symbol}${formatNumber(number / 1e8)}亿`;
    if (abs >= 1e4) return `${symbol}${formatNumber(number / 1e4)}万`;
    return `${symbol}${formatNumber(number)}`;
  };
  return value.kind === 'scalar' ? formatOne(value.value) : `${formatOne(value.min)} – ${formatOne(value.max)}`;
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(value);
}

function formatDelta(percent?: string, absolute?: string): string {
  if (percent !== undefined) {
    const value = Number(percent);
    return `${value >= 0 ? '+' : ''}${formatNumber(value)}%`;
  }
  if (absolute !== undefined) {
    const value = Number(absolute);
    return `${value >= 0 ? '+' : ''}${formatNumber(value)}`;
  }
  return '';
}

function formatComparison(
  comparison: EarningsMetricFactDto['comparisons'][number],
  fact: EarningsMetricFactDto,
): string {
  if (comparison.kind === 'GUIDANCE') {
    const range = comparison.referenceValue?.kind === 'range'
      ? formatRawValue(comparison.referenceValue, fact)
      : '';
    const outcome = comparison.outcome === 'within' ? '区间内' : comparison.outcome === 'above' ? '高于上沿' : '低于下沿';
    return `${comparison.label}${range ? ` ${range}` : ''} · ${outcome}`;
  }
  if (comparison.kind === 'CONSENSUS') {
    return `${comparison.label} ${formatDelta(comparison.percentDelta, comparison.absoluteDelta)}${comparison.asOf ? ` · 披露前 ${formatDateTime(comparison.asOf)}` : ''}`;
  }
  return `${comparison.label} ${formatDelta(comparison.percentDelta, comparison.absoluteDelta)}`;
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function readableError(code?: string, fallback?: string | null): string {
  const labels: Record<string, string> = {
    NO_ELIGIBLE_FILING: '暂未发现支持的财报公告。',
    NO_NEW_ELIGIBLE_FILING: '最新财报公告已经处理。',
    BODY_UNREADABLE: '公告正文暂时无法读取。',
    CHECK_REJECTED_ALL: '本次抽取的数字均未通过一致性检查。',
    PROVIDER_UNAVAILABLE: 'AI 服务暂时不可用。',
    STRUCTURED_PERIOD_UNCONFIRMED: '公告未提供可核对的报告期，已停止结构化降级。',
    STRUCTURED_PERIOD_MISMATCH: '结构化数据尚未更新到本期，已停止展示旧期数字。',
    SERVER_RESTARTED: '生成期间服务重启，可重新尝试。',
  };
  return (code && labels[code]) || fallback || '生成过程出现错误，请稍后重试。';
}
