'use client';

import { Fragment, useState } from 'react';
import { BarChart3, ChevronRight, ExternalLink, Loader2, RotateCw, Table2 } from 'lucide-react';
import type { EarningsTrendOptionDto } from '@bourse/shared-types';
import { Button, Select, SelectOption } from '@/components/ui';
import { useEarningsTrends } from '@/hooks/use-earnings-trends';
import { MetricTrendChart } from '@/components/charts/primitives/metric-trend-chart';
import { cn } from '@/lib/utils';

export function EarningsTrendPanel({ stockId }: { stockId: string }) {
  const trend = useEarningsTrends(stockId);
  const [expanded, setExpanded] = useState<string | null>(null);
  // C7（visualization §5.1）：图/表双视图，图优先（趋势一眼可读），表保留全部口径细节
  const [view, setView] = useState<'chart' | 'table'>('chart');
  if (!trend.supported || trend.options.length === 0) return null;
  const selectedKey = trend.selected ? `${trend.selected.metricCode}:${trend.selected.fingerprint}` : undefined;
  const choose = (value: string) => {
    const next = trend.options.find((option) => `${option.metricCode}:${option.fingerprint}` === value);
    if (next) trend.setSelected(next);
  };
  const derivedCount = trend.series?.points.filter((point) => point.derivationKind === 'YTD_DIFFERENCE').length ?? 0;
  const derivedMostly = Boolean(trend.series?.points.length && derivedCount / trend.series.points.length > 0.5);
  return (
    <section className="mb-7 border-y border-[var(--color-border-soft)] py-4" aria-labelledby="earnings-trend-title">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <BarChart3 className="h-4 w-4 text-[var(--color-fg-3)]" strokeWidth={1.5} />
          <div>
            <h2 id="earnings-trend-title" className="m-0 text-[13px] font-medium text-[var(--color-fg)]">跨期趋势</h2>
            <p className="m-0 mt-0.5 text-[11px] text-[var(--color-fg-3)]">只比较口径一致的已发布数字</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select value={selectedKey} onValueChange={choose} ariaLabel="选择趋势指标" className="h-8 min-w-[170px]" sans>
            {trend.options.map((option) => (
              <SelectOption key={`${option.metricCode}:${option.fingerprint}`} value={`${option.metricCode}:${option.fingerprint}`}>
                {option.label} · {accumulationLabel(option)}{option.derivationKind === 'YTD_DIFFERENCE' ? '（累计差分）' : ''}
              </SelectOption>
            ))}
          </Select>
          <div className="flex h-8 items-center rounded-[var(--radius-btn)] border border-[var(--color-border)] p-0.5" aria-label="视图切换">
            {(['chart', 'table'] as const).map((mode) => (
              <button key={mode} type="button" onClick={() => setView(mode)} className={cn('flex h-6 items-center gap-1 rounded-[5px] px-2 text-[11px] transition-colors', view === mode ? 'bg-[var(--color-fg)] text-[var(--color-bg)]' : 'text-[var(--color-fg-3)] hover:text-[var(--color-fg)]')}>
                {mode === 'chart' ? <BarChart3 className="h-3 w-3" strokeWidth={1.5} /> : <Table2 className="h-3 w-3" strokeWidth={1.5} />}
                {mode === 'chart' ? '图' : '表'}
              </button>
            ))}
          </div>
          <div className="flex h-8 items-center rounded-[var(--radius-btn)] border border-[var(--color-border)] p-0.5" aria-label="趋势期间">
            {([4, 8, 12] as const).map((value) => (
              <button key={value} type="button" onClick={() => trend.setPeriods(value)} className={cn('h-6 min-w-8 rounded-[5px] px-2 font-mono text-[11px] transition-colors', trend.periods === value ? 'bg-[var(--color-fg)] text-[var(--color-bg)]' : 'text-[var(--color-fg-3)] hover:text-[var(--color-fg)]')}>
                {value}期
              </button>
            ))}
          </div>
        </div>
      </div>
      {trend.loading ? (
        <div className="flex h-24 items-center justify-center text-[12px] text-[var(--color-fg-3)]"><Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />加载趋势</div>
      ) : trend.error ? (
        <div className="flex h-24 items-center justify-center gap-2 text-[12px] text-[var(--color-fg-3)]">
          <span>{trend.error}</span>
          <Button type="button" variant="quiet" size="icon" onClick={() => void trend.reload()} title="重新加载趋势" aria-label="重新加载趋势"><RotateCw className="h-3.5 w-3.5" /></Button>
        </div>
      ) : trend.series?.points.length ? (
        view === 'chart' ? (
          <div>
            {derivedMostly ? (
              <p className="m-0 mb-2 rounded-[6px] border border-[var(--color-warn-line)] bg-[var(--color-warn-soft)] px-2.5 py-1.5 text-[11.5px] text-[var(--color-warn)]">
                当前期间超过一半为累计值差分推导，跨期比较的可比性受限；点击柱查看每期口径与来源。
              </p>
            ) : null}
            <MetricTrendChart
              points={trend.series.points.map((point) => ({
                period: point.periodEndOn,
                value: point.value.kind === 'scalar' ? Number(point.value.value) : null,
                yoyPct: point.yoy?.percentDelta !== undefined && point.yoy?.percentDelta !== null ? Number(point.yoy.percentDelta) : null,
                derived: point.derivationKind === 'YTD_DIFFERENCE',
                conflict: point.reconcileStatus === 'conflicted',
              }))}
              valueLabel={trend.selected?.label ?? '指标'}
              unit={trend.selected?.unit === 'currency' ? trend.selected.currency ?? '' : trend.selected?.unit?.startsWith('percent') ? '%' : undefined}
              onPointClick={(period) => {
                const point = trend.series?.points.find((item) => item.periodEndOn === period);
                if (point) {
                  setView('table');
                  setExpanded(`${point.revisionId}:${point.periodType}`);
                }
              }}
            />
            <p className="m-0 mt-1.5 text-[11px] text-[var(--color-fg-3)]">
              纹理柱 = YTD 差分推导期 · 橙描边 = 对账冲突 · 悬停柱看数值与同比；切换到「表」视图查看口径与来源
            </p>
          </div>
        ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] border-collapse text-left">
            <thead><tr className="border-b border-[var(--color-border-soft)] text-[10.5px] text-[var(--color-fg-3)]"><th className="py-2 font-medium">期间</th><th className="py-2 text-right font-medium">数值</th><th className="py-2 text-right font-medium">同比</th><th className="py-2 text-right font-medium">环比</th><th className="py-2 text-right font-medium">状态</th></tr></thead>
            <tbody>{trend.series.points.map((point) => {
              const key = `${point.revisionId}:${point.periodType}`;
              const isExpanded = expanded === key;
              return (
                <Fragment key={key}>
                  <tr className="border-b border-[var(--color-border-soft)]">
                    <td className="py-2.5">
                      <button type="button" className="inline-flex items-center text-left" aria-expanded={isExpanded} onClick={() => setExpanded(isExpanded ? null : key)}>
                        <ChevronRight className={cn('mr-1 h-3.5 w-3.5 text-[var(--color-fg-3)] transition-transform', isExpanded && 'rotate-90')} />
                        <span className="font-mono text-[12px] text-[var(--color-fg)]">{point.fiscalYear} {point.periodType}</span><span className="ml-2 text-[10.5px] text-[var(--color-fg-3)]">{point.periodEndOn}</span>
                      </button>
                    </td>
                    <td className="py-2.5 text-right font-mono text-[13px] font-medium">{formatValue(point.value, trend.selected)}</td>
                    <td className="py-2.5 text-right font-mono text-[11px] text-[var(--color-fg-2)]">{formatDelta(point.yoy)}</td>
                    <td className="py-2.5 text-right font-mono text-[11px] text-[var(--color-fg-2)]">{formatDelta(point.qoq)}</td>
                    <td className="py-2.5 text-right text-[11px] text-[var(--color-fg-3)]">{point.derivationKind === 'YTD_DIFFERENCE' ? '累计差分' : reconcileLabel(point.reconcileStatus)}</td>
                  </tr>
                  {isExpanded ? (
                    <tr className="border-b border-[var(--color-border-soft)] bg-[var(--color-bg-subtle)]">
                      <td colSpan={5} className="px-5 py-3 text-[11px] text-[var(--color-fg-3)]">
                        <div className="flex flex-wrap gap-x-5 gap-y-1">
                          <span>期间：{point.periodStartOn ? `${point.periodStartOn} 至 ` : ''}{point.periodEndOn}</span>
                          <span>口径：{accumulationLabel(trend.selected!)} · {trend.selected?.accountingBasis} · {scopeLabel(trend.selected?.consolidationScope)}</span>
                          <span>来源：{point.derivationKind === 'YTD_DIFFERENCE' ? `累计值差分（${point.inputMetricFactIds.length} 项输入）` : '原始披露'}</span>
                          {point.sourceUrl ? <a className="inline-flex items-center gap-1 text-[var(--color-accent)] hover:underline" href={point.sourceUrl} target="_blank" rel="noreferrer">查看原文<ExternalLink className="h-3 w-3" /></a> : null}
                        </div>
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              );
            })}</tbody>
          </table>
        </div>
        )
      ) : (
        <div className="py-8 text-center text-[12px] text-[var(--color-fg-3)]">暂无足够可比期间</div>
      )}
    </section>
  );
}

function accumulationLabel(option: EarningsTrendOptionDto) {
  return option.accumulation === 'discrete' ? '单期' : option.accumulation;
}
function formatValue(value: { kind: 'scalar'; value: string } | { kind: 'range'; min: string; max: string }, option: EarningsTrendOptionDto | null) {
  const unit = option?.unit;
  const prefix = unit === 'currency' && option?.currency ? `${option.currency} ` : '';
  const suffix = unit === 'percent' || unit === 'percentage_point' ? '%' : '';
  return value.kind === 'scalar' ? `${prefix}${formatCompact(value.value)}${suffix}` : `${prefix}${formatCompact(value.min)}–${formatCompact(value.max)}${suffix}`;
}
function formatCompact(value: string) {
  const number = Number(value);
  if (!Number.isFinite(number)) return value;
  const abs = Math.abs(number);
  if (abs >= 1e9) return `${(number / 1e9).toFixed(2).replace(/\.00$/, '')}B`;
  if (abs >= 1e6) return `${(number / 1e6).toFixed(2).replace(/\.00$/, '')}M`;
  return number.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
}
function signed(value: string) { return value.startsWith('-') || value === '0' ? value : `+${value}`; }
function formatDelta(value?: { absoluteDelta: string; percentDelta?: string }) { return value?.percentDelta ? `${signed(value.percentDelta)}%` : value ? signed(formatCompact(value.absoluteDelta)) : '—'; }
function reconcileLabel(status: string) { return status === 'reconciled' ? '已对账' : status === 'conflicted' ? '冲突' : status === 'pending' ? '待对账' : '仅来源'; }
function scopeLabel(scope?: string) { return scope === 'consolidated' ? '合并' : scope === 'parent' ? '母公司' : '范围未知'; }
