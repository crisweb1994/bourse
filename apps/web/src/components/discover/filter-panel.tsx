'use client';

import {
  ArrowDownUp,
  Plus,
  RotateCcw,
  SlidersHorizontal,
  X,
} from 'lucide-react';
import {
  SCREENER_METRICS,
  type ScreenerMetric,
  type ScreenerOperator,
  type ScreeningConfig,
} from '@bourse/shared-types';
import { Button, Dialog, Input, InputShell, Select, SelectOption } from '@/components/ui';
import { cn } from '@/lib/utils';

export type ConditionDraft = {
  metric: ScreenerMetric;
  operator: ScreenerOperator;
  value: string;
  min: string;
  max: string;
};

export const METRIC_LABELS: Record<string, string> = {
  MARKET_CAP: '总市值',
  NET_INCOME_TTM: '净利润 TTM',
  PE_TTM: '市盈率 TTM',
  PE: '市盈率',
  PB: '市净率',
  PS: '市销率',
  FCF_YIELD: '自由现金流收益率',
  GROSS_MARGIN: '毛利率',
  OPERATING_MARGIN: '营业利润率',
  NET_MARGIN: '净利率',
  ROE: '净资产收益率',
  REVENUE_GROWTH_YOY: '收入同比增长',
  EARNINGS_GROWTH_YOY: '利润同比增长',
  DEBT_TO_EQUITY: '负债权益比',
  CURRENT_RATIO: '流动比率',
  INTEREST_COVERAGE: '利息保障倍数',
  PRICE: '最新价',
  PRICE_VS_SMA20: '价格相对 SMA20',
  PRICE_VS_SMA50: '价格相对 SMA50',
  PRICE_VS_SMA200: '价格相对 SMA200',
  RSI14: 'RSI 14',
  MACD_STATE: 'MACD 状态',
  ATR14_PCT: 'ATR14 / 价格',
  SECTOR: '板块',
  INDUSTRY: '行业',
  CHANGE_PCT: '涨跌幅',
  TURNOVER_RATE: '换手率',
};

const METRIC_HINTS: Record<string, string> = {
  MARKET_CAP: '基础货币',
  NET_INCOME_TTM: '基础货币',
  PE_TTM: '倍',
  PB: '倍',
  REVENUE_GROWTH_YOY: '%',
  PRICE: '基础货币',
  CHANGE_PCT: '%',
  TURNOVER_RATE: '%',
};

const OPERATOR_LABELS: Record<ScreenerOperator, string> = {
  GTE: '大于等于',
  LTE: '小于等于',
  BETWEEN: '区间',
};

type Props = {
  open: boolean;
  config: ScreeningConfig | null;
  conditions: ConditionDraft[];
  sortMetric: ScreenerMetric;
  sortDirection: 'ASC' | 'DESC';
  selectedPresetId: string | null;
  errorIndex: number | null;
  running: boolean;
  onClose: () => void;
  onChangeCondition: (index: number, patch: Partial<ConditionDraft>) => void;
  onRemoveCondition: (index: number) => void;
  onAddCondition: () => void;
  onApplyPreset: (presetId: string) => void;
  onReset: () => void;
  onChangeSortMetric: (metric: ScreenerMetric) => void;
  onChangeSortDirection: (direction: 'ASC' | 'DESC') => void;
  onRun: () => void;
};

export function FilterPanel({
  open,
  config,
  conditions,
  sortMetric,
  sortDirection,
  selectedPresetId,
  errorIndex,
  running,
  onClose,
  onChangeCondition,
  onRemoveCondition,
  onAddCondition,
  onApplyPreset,
  onReset,
  onChangeSortMetric,
  onChangeSortDirection,
  onRun,
}: Props) {
  const supportedMetrics = config?.metrics.map((entry) => entry.metric) ?? [];
  const metrics = supportedMetrics.length > 0
    ? supportedMetrics
    : [...SCREENER_METRICS];
  const sortableMetrics = config?.sortableMetrics.length
    ? config.sortableMetrics
    : metrics;
  const unsupportedSort = Boolean(
    config?.available && !config.sortableMetrics.includes(sortMetric),
  );
  const sortMetricOptions = unsupportedSort
    ? [sortMetric, ...sortableMetrics]
    : sortableMetrics;

  const panelContent = (
    <>
      <div className="flex items-center gap-2 border-b border-[var(--color-border-soft)] px-4 py-3.5">
        <SlidersHorizontal className="h-4 w-4 text-[var(--color-fg-2)]" strokeWidth={1.5} />
        <div className="min-w-0">
          <h2 className="m-0 text-[14px] font-medium">筛选条件</h2>
          <p className="m-0 mt-0.5 font-mono text-[10.5px] text-[var(--color-fg-3)]">
            {conditions.length} 条 · 全部 AND
          </p>
        </div>
        <Button
          type="button"
          variant="quiet"
          size="icon"
          className="ml-auto lg:hidden"
          onClick={onClose}
          aria-label="关闭筛选条件"
        >
          <X className="h-4 w-4" />
        </Button>
      </div>

      <fieldset
        disabled={running}
        className="m-0 flex min-h-0 flex-1 flex-col border-0 p-0"
      >
        <div className="flex-1 px-4 py-4">
        <div className="mb-5">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[12px] font-medium text-[var(--color-fg-2)]">研究预设</span>
            <span className="font-mono text-[10px] text-[var(--color-fg-3)]">应用后可编辑</span>
          </div>
          {config?.presets.length ? (
            <div className="flex flex-wrap gap-1.5">
              {config.presets.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  onClick={() => onApplyPreset(preset.id)}
                  title={preset.description}
                  className={cn(
                    'min-h-8 rounded-[var(--radius-btn)] border px-2.5 py-1 text-[12px] transition-colors',
                    selectedPresetId === preset.id
                      ? 'border-[var(--color-accent-line)] bg-[var(--color-accent-soft)] text-[var(--color-accent-600)]'
                      : 'border-[var(--color-border)] bg-[var(--color-bg)] text-[var(--color-fg-2)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-fg)]',
                  )}
                >
                  {preset.name}
                </button>
              ))}
            </div>
          ) : (
            <p className="m-0 text-[12px] text-[var(--color-fg-3)]">当前市场没有可执行预设。</p>
          )}
        </div>

        <div className="border-t border-[var(--color-border-soft)]">
          {conditions.map((condition, index) => {
            const descriptor = config?.metrics.find(
              (entry) => entry.metric === condition.metric,
            );
            const operators = descriptor?.operators ?? ['GTE', 'LTE', 'BETWEEN'];
            const unsupported = Boolean(config && !descriptor);
            const conditionMetrics = metrics.includes(condition.metric)
              ? metrics
              : [condition.metric, ...metrics];
            const invalidRange =
              condition.operator === 'BETWEEN' &&
              Number.isFinite(Number(condition.min)) &&
              Number.isFinite(Number(condition.max)) &&
              Number(condition.min) > Number(condition.max);
            const hasError = errorIndex === index || unsupported || invalidRange;

            return (
              <div
                key={`${condition.metric}-${index}`}
                className={cn(
                  'border-b border-[var(--color-border-soft)] py-3.5',
                  hasError && 'bg-[var(--color-danger-soft)] -mx-2 px-2',
                )}
              >
                <div className="mb-2 flex items-center gap-2">
                  <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-[var(--color-surface-2)] font-mono text-[10px] text-[var(--color-fg-2)]">
                    {index + 1}
                  </span>
                  <Select
                    value={condition.metric}
                    onValueChange={(value) => {
                      const metric = value as ScreenerMetric;
                      const nextOperators = config?.metrics.find(
                        (entry) => entry.metric === metric,
                      )?.operators;
                      onChangeCondition(index, {
                        metric,
                        operator: nextOperators?.[0] ?? 'GTE',
                      });
                    }}
                    className="h-9 min-w-0 flex-1"
                    sans
                    ariaLabel={`第 ${index + 1} 条条件指标`}
                  >
                    {conditionMetrics.map((metric) => (
                      <SelectOption
                        key={metric}
                        value={metric}
                        disabled={unsupported && metric === condition.metric}
                      >
                        {METRIC_LABELS[metric] ?? metric}
                      </SelectOption>
                    ))}
                  </Select>
                  <Button
                    type="button"
                    variant="quiet"
                    size="icon"
                    onClick={() => onRemoveCondition(index)}
                    aria-label={`删除第 ${index + 1} 条条件`}
                  >
                    <X className="h-3.5 w-3.5" />
                  </Button>
                </div>

                <div className={cn('grid gap-2 pl-7', condition.operator === 'BETWEEN' ? 'grid-cols-[106px_1fr_1fr]' : 'grid-cols-[106px_1fr]')}>
                  <Select
                    value={condition.operator}
                    onValueChange={(value) =>
                      onChangeCondition(index, {
                        operator: value as ScreenerOperator,
                      })
                    }
                    className="h-9"
                    sans
                    ariaLabel={`${METRIC_LABELS[condition.metric] ?? condition.metric}操作符`}
                  >
                    {operators.map((operator) => (
                      <SelectOption key={operator} value={operator}>
                        {OPERATOR_LABELS[operator]}
                      </SelectOption>
                    ))}
                  </Select>
                  {condition.operator === 'BETWEEN' ? (
                    <>
                      <NumberField
                        value={condition.min}
                        onChange={(min) => onChangeCondition(index, { min })}
                        label="下限"
                        hint={METRIC_HINTS[condition.metric]}
                      />
                      <NumberField
                        value={condition.max}
                        onChange={(max) => onChangeCondition(index, { max })}
                        label="上限"
                        hint={METRIC_HINTS[condition.metric]}
                      />
                    </>
                  ) : (
                    <NumberField
                      value={condition.value}
                      onChange={(value) => onChangeCondition(index, { value })}
                      label="阈值"
                      hint={METRIC_HINTS[condition.metric]}
                    />
                  )}
                </div>
                {hasError && (
                  <p className="mb-0 mt-2 pl-7 text-[11.5px] text-[var(--color-danger)]">
                    {unsupported
                      ? '当前数据源不支持这个指标。'
                      : invalidRange
                        ? '区间下限不能大于上限。'
                        : '请检查这条条件。'}
                  </p>
                )}
              </div>
            );
          })}
        </div>

        <Button
          type="button"
          variant="quiet"
          size="sm"
          className="mt-2 w-full"
          onClick={onAddCondition}
          disabled={conditions.length >= 20 || !config?.available}
        >
          <Plus className="h-3.5 w-3.5" />
          添加条件
        </Button>

        <div
          className={cn(
            'mt-5 border-t border-[var(--color-border-soft)] pt-4',
            unsupportedSort && '-mx-2 bg-[var(--color-danger-soft)] px-2 pb-2',
          )}
        >
          <div className="mb-2 flex items-center gap-1.5 text-[12px] font-medium text-[var(--color-fg-2)]">
            <ArrowDownUp className="h-3.5 w-3.5" strokeWidth={1.5} />
            初筛排序
          </div>
          <div className="grid grid-cols-[1fr_92px] gap-2">
            <Select
              value={sortMetric}
              onValueChange={(value) => onChangeSortMetric(value as ScreenerMetric)}
              className="h-9 min-w-0"
              sans
              ariaLabel="初筛排序指标"
            >
              {sortMetricOptions.map((metric) => (
                <SelectOption
                  key={metric}
                  value={metric}
                  disabled={unsupportedSort && metric === sortMetric}
                >
                  {METRIC_LABELS[metric] ?? metric}
                </SelectOption>
              ))}
            </Select>
            <Select
              value={sortDirection}
              onValueChange={(value) => onChangeSortDirection(value as 'ASC' | 'DESC')}
              className="h-9"
              sans
              ariaLabel="排序方向"
            >
              <SelectOption value="DESC">降序</SelectOption>
              <SelectOption value="ASC">升序</SelectOption>
            </Select>
          </div>
          {unsupportedSort && (
            <p className="mb-0 mt-2 text-[11.5px] text-[var(--color-danger)]">
              当前数据源不支持这个排序指标，请重新选择。
            </p>
          )}
        </div>

        {config?.universeRules.length ? (
          <div className="mt-5 border-t border-[var(--color-border-soft)] pt-4">
            <p className="m-0 text-[11.5px] font-medium text-[var(--color-fg-2)]">
              {config.universeLabel}
            </p>
            <ul className="mb-0 mt-1.5 space-y-1 pl-4 text-[11px] leading-[1.55] text-[var(--color-fg-3)]">
              {config.universeRules.map((rule) => <li key={rule}>{rule}</li>)}
            </ul>
          </div>
        ) : null}
        </div>

        <div className="sticky bottom-0 border-t border-[var(--color-border)] bg-[var(--color-bg-elev)] px-4 py-3">
          <div className="flex gap-2">
            <Button
              type="button"
              variant="primary"
              className="flex-1"
              onClick={onRun}
              disabled={running || !config?.available || conditions.length === 0}
            >
              {running ? '正在筛选…' : '运行筛选'}
            </Button>
            <Button type="button" size="icon" onClick={onReset} aria-label="恢复预设">
              <RotateCcw className="h-3.5 w-3.5" />
            </Button>
          </div>
          <p className="mb-0 mt-2 text-[10.5px] leading-[1.45] text-[var(--color-fg-3)]">
            结果只表示满足所选条件，仍需进一步研究。
          </p>
        </div>
      </fieldset>
    </>
  );

  return (
    <>
      <aside
        aria-label="筛选条件"
        className="hidden flex-col self-start rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-bg-elev)] lg:sticky lg:top-6 lg:flex lg:max-h-[calc(100vh-48px)] lg:overflow-y-auto"
      >
        {panelContent}
      </aside>
      <div className="lg:hidden">
        <Dialog
          open={open}
          onOpenChange={(nextOpen) => !nextOpen && onClose()}
          ariaLabel="筛选条件"
          className="flex !h-[100dvh] !max-h-[100dvh] !w-screen !max-w-none flex-col !rounded-none !border-0"
        >
          {panelContent}
        </Dialog>
      </div>
    </>
  );
}

function NumberField({
  value,
  onChange,
  label,
  hint,
}: {
  value: string;
  onChange: (value: string) => void;
  label: string;
  hint?: string;
}) {
  return (
    <InputShell
      className="h-9 min-w-0"
      trailing={hint ? <span className="max-w-16 truncate font-mono text-[9.5px] text-[var(--color-fg-3)]">{hint}</span> : null}
    >
      <Input
        type="number"
        inputMode="decimal"
        step="any"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-label={label}
        className="min-w-0 px-2.5"
      />
    </InputShell>
  );
}
