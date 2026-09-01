'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import {
  ArrowUpDown,
  ArrowUpRight,
  Check,
  ChevronDown,
  ChevronUp,
  CircleAlert,
  CircleCheck,
  Columns3,
  Loader2,
  PanelRightOpen,
  Pin,
  Play,
  RefreshCw,
  ScanSearch,
  Search,
  SlidersHorizontal,
  Square,
} from 'lucide-react';
import type {
  ScreeningCandidateRow,
  ScreeningCondition,
  ScreeningMetricCell,
  ScreeningRefinementDto,
  ScreeningRunDto,
  ScreeningView,
  ScreeningViewColumn,
} from '@bourse/shared-types';
import { stockHref } from '@/lib/stock-href';
import {
  Button,
  Card,
  Dialog,
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Input,
  InputShell,
  Pill,
  Sym,
  Table,
  TBody,
  THead,
} from '@/components/ui';
import { cn } from '@/lib/utils';
import { METRIC_LABELS } from './filter-panel';

const VIEW_LABELS: Record<ScreeningViewColumn, string> = {
  SECURITY: '证券',
  PRICE: '价格',
  SORT_METRIC: '主排序指标',
  CONDITION_MATCH: '条件命中',
  REFINE_STATUS: '证据状态',
  PE: 'PE',
  PB: 'PB',
  ROE: 'ROE',
  RSI14: 'RSI 14',
};

type Props = {
  run: ScreeningRunDto | null;
  view: ScreeningView;
  refinements: Map<string, ScreeningRefinementDto>;
  selectedKeys: Set<string>;
  failedKeys: Set<string>;
  inFlightKeys: Set<string>;
  watchedKeys: Set<string>;
  watchlistLoaded: boolean;
  addingKeys: Set<string>;
  retryingKeys: Set<string>;
  refineTarget: 25 | 50;
  refineRunning: boolean;
  refineAttemptedCount: number;
  onChangeView: (view: ScreeningView) => void;
  onToggleSelected: (identityKey: string, selected: boolean) => void;
  onClearSelection: () => void;
  onToggleRefine: () => void;
  onExtendRefine: () => void;
  onRetry: (identityKey: string) => void;
  onAddWatchlist: (row: ScreeningCandidateRow) => Promise<void>;
};

export function ResultsTable({
  run,
  view,
  refinements,
  selectedKeys,
  failedKeys,
  inFlightKeys,
  watchedKeys,
  watchlistLoaded,
  addingKeys,
  retryingKeys,
  refineTarget,
  refineRunning,
  refineAttemptedCount,
  onChangeView,
  onToggleSelected,
  onClearSelection,
  onToggleRefine,
  onExtendRefine,
  onRetry,
  onAddWatchlist,
}: Props) {
  const [search, setSearch] = useState('');
  const [evidenceKey, setEvidenceKey] = useState<string | null>(null);
  const [compareOpen, setCompareOpen] = useState(false);

  const rows = useMemo(() => {
    if (!run) return [];
    const needle = search.trim().toLocaleLowerCase();
    const filtered = needle
      ? run.snapshot.items.filter((row) =>
          `${row.symbol} ${row.name ?? ''} ${row.exchange ?? ''}`
            .toLocaleLowerCase()
            .includes(needle),
        )
      : [...run.snapshot.items];
    return sortRows(filtered, run, view, refinements);
  }, [refinements, run, search, view]);

  const selectedRows = run?.snapshot.items.filter((row) =>
    selectedKeys.has(row.identityKey),
  ) ?? [];
  const evidenceRow = run?.snapshot.items.find(
    (row) => row.identityKey === evidenceKey,
  ) ?? null;
  const targetCount = Math.min(refineTarget, run?.snapshot.items.length ?? 0);
  const refinedCount = run
    ? run.snapshot.items
        .slice(0, targetCount)
        .filter((row) => refinements.has(row.identityKey)).length
    : 0;
  const attemptedCount = Math.min(refineAttemptedCount, targetCount);

  if (!run) {
    return (
      <Card className="min-h-[480px]">
        <div className="grid min-h-[480px] place-items-center px-6 text-center">
          <div className="max-w-[380px]">
            <span className="mx-auto grid h-10 w-10 place-items-center rounded-full border border-[var(--color-border)] text-[var(--color-fg-2)]">
              <ScanSearch className="h-4.5 w-4.5" strokeWidth={1.5} />
            </span>
            <h2 className="mb-0 mt-4 text-[16px] font-medium">从透明条件开始</h2>
            <p className="mb-0 mt-2 text-[13px] leading-[1.6] text-[var(--color-fg-2)]">
              选择预设或编辑左侧条件。运行后会冻结一次全市场候选快照，再逐步补充财务与技术证据。
            </p>
          </div>
        </div>
      </Card>
    );
  }

  return (
    <section className="min-w-0" aria-label="筛选结果">
      <RunWaterfall run={run} />

      {run.snapshot.items.length > 0 && (
        <RefineBar
          target={targetCount}
          refined={refinedCount}
          attempted={attemptedCount}
          running={refineRunning}
          total={run.snapshot.items.length}
          onToggle={onToggleRefine}
          onExtend={onExtendRefine}
        />
      )}

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <InputShell leading={<Search />} className="h-9 w-full sm:w-[260px]" sans>
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="搜索候选"
            aria-label="搜索候选"
          />
        </InputShell>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" size="sm">
              <SlidersHorizontal className="h-3.5 w-3.5" />
              显示列
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-48">
            <DropdownMenuLabel>结果列</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {(Object.keys(VIEW_LABELS) as ScreeningViewColumn[]).map((column) => (
              <DropdownMenuCheckboxItem
                key={column}
                checked={view.visibleColumns.includes(column)}
                disabled={column === 'SECURITY'}
                onCheckedChange={(checked) => {
                  const visibleColumns = checked
                    ? [...view.visibleColumns, column]
                    : view.visibleColumns.filter((item) => item !== column);
                  if (visibleColumns.length === 0) return;
                  onChangeView({ ...view, visibleColumns });
                }}
              >
                {VIEW_LABELS[column]}
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        <span className="font-mono text-[11px] text-[var(--color-fg-3)]">
          {search ? `${rows.length} / ${run.snapshot.items.length}` : `${run.snapshot.items.length} 只已冻结`}
        </span>

        {selectedKeys.size > 0 && (
          <div className="ml-0 flex w-full items-center gap-2 border-t border-[var(--color-border-soft)] pt-2 sm:ml-auto sm:w-auto sm:border-0 sm:pt-0">
            <span className="mr-auto text-[12px] text-[var(--color-fg-2)] sm:mr-0">
              已选 {selectedKeys.size} 只
            </span>
            <Button
              type="button"
              size="sm"
              variant="primary"
              disabled={selectedKeys.size < 2 || selectedKeys.size > 5}
              onClick={() => setCompareOpen(true)}
            >
              <Columns3 className="h-3.5 w-3.5" />
              对比
            </Button>
            <Button type="button" size="sm" variant="quiet" onClick={onClearSelection}>
              清除
            </Button>
          </div>
        )}
      </div>

      <Card>
        {rows.length === 0 ? (
          <div className="grid min-h-[300px] place-items-center px-6 text-center">
            <div>
              <Search className="mx-auto h-5 w-5 text-[var(--color-fg-3)]" strokeWidth={1.5} />
              <p className="mb-0 mt-3 text-[13px] text-[var(--color-fg-2)]">
                {run.snapshot.items.length === 0
                  ? '没有股票满足当前条件，可调整条件后重新运行。'
                  : '没有匹配当前搜索的候选。'}
              </p>
            </div>
          </div>
        ) : (
          <>
            <div className="hidden overflow-x-auto md:block">
              <Table className="min-w-[920px] table-fixed">
                <THead>
                  <tr>
                    <th className="w-11" aria-label="选择" />
                    {view.visibleColumns.map((column) => (
                      <ResultHeader
                        key={column}
                        column={column}
                        run={run}
                        view={view}
                        onChangeView={onChangeView}
                      />
                    ))}
                    <th className="w-[104px] text-right">操作</th>
                  </tr>
                </THead>
                <TBody>
                  {rows.map((row) => (
                    <DesktopRow
                      key={row.identityKey}
                      row={row}
                      run={run}
                      view={view}
                      refinement={refinements.get(row.identityKey)}
                      selected={selectedKeys.has(row.identityKey)}
                      failed={failedKeys.has(row.identityKey)}
                      inFlight={inFlightKeys.has(row.identityKey)}
                      watched={watchedKeys.has(row.identityKey)}
                      watchlistLoaded={watchlistLoaded}
                      adding={addingKeys.has(row.identityKey)}
                      retrying={retryingKeys.has(row.identityKey)}
                      onToggleSelected={onToggleSelected}
                      onEvidence={() => setEvidenceKey(row.identityKey)}
                      onRetry={onRetry}
                      onAddWatchlist={onAddWatchlist}
                    />
                  ))}
                </TBody>
              </Table>
            </div>

            <div className="divide-y divide-[var(--color-border-soft)] md:hidden">
              {rows.map((row) => (
                <MobileRow
                  key={row.identityKey}
                  row={row}
                  run={run}
                  refinement={refinements.get(row.identityKey)}
                  selected={selectedKeys.has(row.identityKey)}
                  failed={failedKeys.has(row.identityKey)}
                  inFlight={inFlightKeys.has(row.identityKey)}
                  onToggleSelected={onToggleSelected}
                  onEvidence={() => setEvidenceKey(row.identityKey)}
                />
              ))}
            </div>
          </>
        )}
      </Card>

      <EvidenceDialog
        open={Boolean(evidenceRow)}
        onOpenChange={(open) => !open && setEvidenceKey(null)}
        row={evidenceRow}
        run={run}
        refinement={evidenceRow ? refinements.get(evidenceRow.identityKey) : undefined}
        failed={evidenceRow ? failedKeys.has(evidenceRow.identityKey) : false}
        watched={evidenceRow ? watchedKeys.has(evidenceRow.identityKey) : false}
        watchlistLoaded={watchlistLoaded}
        adding={evidenceRow ? addingKeys.has(evidenceRow.identityKey) : false}
        retrying={evidenceRow ? retryingKeys.has(evidenceRow.identityKey) : false}
        onRetry={onRetry}
        onAddWatchlist={onAddWatchlist}
      />

      <CompareDialog
        open={compareOpen}
        onOpenChange={setCompareOpen}
        rows={selectedRows}
        run={run}
        refinements={refinements}
      />
    </section>
  );
}

function RunWaterfall({ run }: { run: ScreeningRunDto }) {
  const hasConditionCounts =
    run.snapshot.conditionCounts?.length === run.query.conditions.length;
  const steps = hasConditionCounts
    ? [
        { label: '活跃普通股', value: run.snapshot.universeCount },
        ...run.query.conditions.map((condition, index) => ({
          label: formatCondition(condition),
          value: run.snapshot.conditionCounts![index]!,
        })),
      ]
    : [
        { label: '活跃普通股', value: run.snapshot.universeCount },
        { label: '全部条件', value: run.snapshot.matchedCount },
      ];
  const max = Math.max(steps[0]?.value ?? 1, 1);
  const snapshotWarnings = (run.snapshot.warnings ?? []).slice(0, 3);

  return (
    <div className="mb-4 border-y border-[var(--color-border-soft)] py-3.5">
      <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1">
        <div className="flex items-center gap-1.5 text-[12px] font-medium">
          <ArrowUpDown className="h-3.5 w-3.5 text-[var(--color-fg-2)]" strokeWidth={1.5} />
          筛选瀑布
        </div>
        <Pill variant={run.snapshot.complete ? 'emerald' : 'warn'} dot>
          {run.snapshot.complete ? '完整快照' : '部分快照'}
        </Pill>
        <span className="font-mono text-[10.5px] text-[var(--color-fg-3)]">
          {formatAsOf(run.snapshot.providerAsOf)}
        </span>
        {run.snapshot.truncated && (
          <span className="ml-auto text-[11px] text-[var(--color-warn)]">
            共匹配 {run.snapshot.matchedCount.toLocaleString('zh-CN')}，展示前 {run.snapshot.items.length}
          </span>
        )}
      </div>
      {snapshotWarnings.length > 0 && (
        <div className="mb-3 bg-[var(--color-warn-soft)] px-3 py-2.5 text-[11.5px] leading-[1.55] text-[var(--color-warn)]">
          <ul className="m-0 space-y-1 pl-4">
            {snapshotWarnings.map((warning, index) => (
              <li
                key={`${warning.code}-${warning.provider ?? ''}-${index}`}
                className="line-clamp-2 break-words"
              >
                {warning.message}
              </li>
            ))}
          </ul>
          {(run.snapshot.warnings?.length ?? 0) > snapshotWarnings.length && (
            <p className="mb-0 mt-1.5 text-[10.5px]">
              另有 {(run.snapshot.warnings?.length ?? 0) - snapshotWarnings.length} 条快照提示
            </p>
          )}
        </div>
      )}
      <div className="overflow-x-auto pb-1">
        <div className="flex min-w-max gap-2">
          {steps.map((step, index) => (
            <div key={`${step.label}-${index}`} className="w-[142px] shrink-0">
              <div className="mb-1.5 h-1.5 overflow-hidden rounded-full bg-[var(--color-surface-2)]">
                <span
                  className="block h-full rounded-full bg-[var(--color-accent)]"
                  style={{ width: `${Math.max(6, Math.min(100, (step.value / max) * 100))}%` }}
                />
              </div>
              <div className="font-mono text-[13px] font-medium">{step.value.toLocaleString('zh-CN')}</div>
              <div className="mt-0.5 truncate text-[10.5px] text-[var(--color-fg-3)]" title={step.label}>
                {step.label}
              </div>
            </div>
          ))}
        </div>
      </div>
      {!hasConditionCounts && run.query.conditions.length > 1 && (
        <p className="mb-0 mt-2 text-[10.5px] text-[var(--color-fg-3)]">
          当前数据源未提供逐条件计数，仅展示股票池与最终匹配数。
        </p>
      )}
    </div>
  );
}

function RefineBar({
  target,
  refined,
  attempted,
  running,
  total,
  onToggle,
  onExtend,
}: {
  target: number;
  refined: number;
  attempted: number;
  running: boolean;
  total: number;
  onToggle: () => void;
  onExtend: () => void;
}) {
  const complete = attempted >= target && target > 0;
  const canExtend = complete && target < Math.min(50, total);
  const progress = target > 0 ? Math.min(100, (attempted / target) * 100) : 0;
  return (
    <div className="mb-4 flex flex-wrap items-center gap-3 border border-[var(--color-accent-line)] bg-[var(--color-accent-soft)] px-3.5 py-3">
      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full border border-[var(--color-accent-line)] text-[var(--color-accent-600)]">
        {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <ScanSearch className="h-4 w-4" />}
      </span>
      <div className="min-w-[150px] flex-1">
        <div className="flex items-center justify-between gap-3">
          <span className="text-[12px] font-medium text-[var(--color-fg)]">
            {running ? '正在补充证据' : complete ? '本轮证据增强完成' : '证据增强已停止'}
          </span>
          <span className="font-mono text-[10.5px] text-[var(--color-accent-600)]">
            {refined} 已写入 · {attempted} / {target}
          </span>
        </div>
        <div className="mt-2 h-1 overflow-hidden rounded-full bg-[var(--color-accent-line)]">
          <span className="block h-full bg-[var(--color-accent)] transition-[width] duration-200" style={{ width: `${progress}%` }} />
        </div>
      </div>
      {canExtend ? (
        <Button type="button" size="sm" onClick={onExtend}>
          <Play className="h-3.5 w-3.5" />
          继续到 {Math.min(50, total)}
        </Button>
      ) : !complete ? (
        <Button type="button" size="sm" onClick={onToggle}>
          {running ? <Square className="h-3 w-3" /> : <Play className="h-3.5 w-3.5" />}
          {running ? '停止' : '继续'}
        </Button>
      ) : null}
    </div>
  );
}

function ResultHeader({
  column,
  run,
  view,
  onChangeView,
}: {
  column: ScreeningViewColumn;
  run: ScreeningRunDto;
  view: ScreeningView;
  onChangeView: (view: ScreeningView) => void;
}) {
  const active = view.displaySort?.column === column;
  const label = column === 'SORT_METRIC'
    ? METRIC_LABELS[run.query.sort.metric] ?? run.query.sort.metric
    : VIEW_LABELS[column];
  const width = column === 'SECURITY' ? 'w-[190px]' : column === 'REFINE_STATUS' ? 'w-[120px]' : 'w-[112px]';
  return (
    <th className={width}>
      <button
        type="button"
        className="inline-flex items-center gap-1 hover:text-[var(--color-fg)]"
        onClick={() =>
          onChangeView({
            ...view,
            displaySort: {
              column,
              direction: active && view.displaySort?.direction === 'ASC' ? 'DESC' : 'ASC',
            },
          })
        }
      >
        {label}
        {active ? (
          view.displaySort?.direction === 'ASC' ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />
        ) : null}
      </button>
    </th>
  );
}

function DesktopRow({
  row,
  run,
  view,
  refinement,
  selected,
  failed,
  inFlight,
  watched,
  watchlistLoaded,
  adding,
  retrying,
  onToggleSelected,
  onEvidence,
  onRetry,
  onAddWatchlist,
}: {
  row: ScreeningCandidateRow;
  run: ScreeningRunDto;
  view: ScreeningView;
  refinement?: ScreeningRefinementDto;
  selected: boolean;
  failed: boolean;
  inFlight: boolean;
  watched: boolean;
  watchlistLoaded: boolean;
  adding: boolean;
  retrying: boolean;
  onToggleSelected: (identityKey: string, selected: boolean) => void;
  onEvidence: () => void;
  onRetry: (identityKey: string) => void;
  onAddWatchlist: (row: ScreeningCandidateRow) => Promise<void>;
}) {
  return (
    <tr className={selected ? 'bg-[var(--color-accent-soft)]' : undefined}>
      <td>
        <input
          type="checkbox"
          checked={selected}
          onChange={(event) => onToggleSelected(row.identityKey, event.target.checked)}
          aria-label={`选择 ${row.symbol}`}
          className="h-3.5 w-3.5 accent-[var(--color-accent)]"
        />
      </td>
      {view.visibleColumns.map((column) => (
        <td key={column}>
          <ResultCell column={column} row={row} run={run} refinement={refinement} failed={failed} inFlight={inFlight} retrying={retrying} onRetry={onRetry} />
        </td>
      ))}
      <td>
        <div className="flex items-center justify-end gap-0.5">
          <Button
            type="button"
            variant="quiet"
            size="icon"
            onClick={() => void onAddWatchlist(row)}
            disabled={!watchlistLoaded || adding || watched}
            aria-label={watched ? `${row.symbol} 已在自选` : !watchlistLoaded ? `${row.symbol} 自选状态加载中` : `将 ${row.symbol} 加入自选`}
            title={watched ? '已在自选' : !watchlistLoaded ? '自选状态加载中' : '加入自选'}
          >
            {adding ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : watched ? <Check className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}
          </Button>
          <Button type="button" variant="quiet" size="icon" onClick={onEvidence} aria-label={`查看 ${row.symbol} 证据`} title="查看证据">
            <PanelRightOpen className="h-3.5 w-3.5" />
          </Button>
          <Link
            href={stockHref({ symbol: row.symbol, market: run.query.market, name: row.name ?? row.symbol })}
            className="grid h-7 w-7 place-items-center rounded-[var(--radius-btn)] text-[var(--color-fg-2)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-fg)]"
            aria-label={`打开 ${row.symbol} 个股页`}
            title="进入个股"
          >
            <ArrowUpRight className="h-3.5 w-3.5" />
          </Link>
        </div>
      </td>
    </tr>
  );
}

function ResultCell({
  column,
  row,
  run,
  refinement,
  failed,
  inFlight,
  retrying,
  onRetry,
}: {
  column: ScreeningViewColumn;
  row: ScreeningCandidateRow;
  run: ScreeningRunDto;
  refinement?: ScreeningRefinementDto;
  failed: boolean;
  inFlight: boolean;
  retrying: boolean;
  onRetry: (identityKey: string) => void;
}) {
  if (column === 'SECURITY') {
    return (
      <div className="min-w-0">
        <Sym>{row.symbol}</Sym>
        <div className="mt-0.5 truncate text-[11.5px] text-[var(--color-fg-3)]" title={row.name ?? row.symbol}>
          {row.name ?? '名称缺失'}
        </div>
      </div>
    );
  }
  if (column === 'PRICE') return <MetricValue cell={metricCell(row, 'PRICE')} currency={row.currency} metric="PRICE" />;
  if (column === 'SORT_METRIC') return <MetricValue cell={metricCell(row, run.query.sort.metric)} currency={row.currency} metric={run.query.sort.metric} />;
  if (column === 'CONDITION_MATCH') {
    return <span className="font-mono text-[11.5px] text-[var(--color-fg-2)]">{row.matchedConditionIndexes.length} / {run.query.conditions.length}</span>;
  }
  if (column === 'REFINE_STATUS') {
    return <RefineStatus row={row} refinement={refinement} failed={failed} inFlight={inFlight} retrying={retrying} onRetry={onRetry} />;
  }
  const aliases = column === 'PE' ? ['PE', 'pe', 'PE_TTM'] : column === 'PB' ? ['PB', 'pb'] : column === 'ROE' ? ['ROE', 'roe'] : ['RSI14', 'rsi14'];
  const cell = refinementCell(refinement, aliases) ?? (column === 'PE' ? metricCell(row, 'PE_TTM') : column === 'PB' ? metricCell(row, 'PB') : undefined);
  return <MetricValue cell={cell} currency={row.currency} metric={column} />;
}

function MobileRow({
  row,
  run,
  refinement,
  selected,
  failed,
  inFlight,
  onToggleSelected,
  onEvidence,
}: {
  row: ScreeningCandidateRow;
  run: ScreeningRunDto;
  refinement?: ScreeningRefinementDto;
  selected: boolean;
  failed: boolean;
  inFlight: boolean;
  onToggleSelected: (identityKey: string, selected: boolean) => void;
  onEvidence: () => void;
}) {
  return (
    <div className={cn('px-3.5 py-3', selected && 'bg-[var(--color-accent-soft)]')}>
      <div className="flex items-start gap-3">
        <input type="checkbox" checked={selected} onChange={(event) => onToggleSelected(row.identityKey, event.target.checked)} aria-label={`选择 ${row.symbol}`} className="mt-1 h-3.5 w-3.5 accent-[var(--color-accent)]" />
        <button type="button" onClick={onEvidence} className="min-w-0 flex-1 text-left">
          <div className="flex items-baseline gap-2">
            <Sym>{row.symbol}</Sym>
            <span className="truncate text-[12px] text-[var(--color-fg-3)]">{row.name ?? '名称缺失'}</span>
          </div>
          <div className="mt-2 grid grid-cols-3 gap-2">
            <MobileMetric label="价格"><MetricValue cell={metricCell(row, 'PRICE')} currency={row.currency} metric="PRICE" /></MobileMetric>
            <MobileMetric label={METRIC_LABELS[run.query.sort.metric] ?? run.query.sort.metric}><MetricValue cell={metricCell(row, run.query.sort.metric)} currency={row.currency} metric={run.query.sort.metric} /></MobileMetric>
            <MobileMetric label="命中"><span className="font-mono text-[11.5px]">{row.matchedConditionIndexes.length}/{run.query.conditions.length}</span></MobileMetric>
          </div>
        </button>
        <RefineStatus row={row} refinement={refinement} failed={failed} inFlight={inFlight} retrying={false} compact />
      </div>
    </div>
  );
}

function MobileMetric({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <span className="min-w-0">
      <span className="block truncate font-mono text-[9.5px] text-[var(--color-fg-3)]">{label}</span>
      <span className="mt-0.5 block truncate">{children}</span>
    </span>
  );
}

function RefineStatus({
  row,
  refinement,
  failed,
  inFlight,
  retrying,
  onRetry,
  compact,
}: {
  row: ScreeningCandidateRow;
  refinement?: ScreeningRefinementDto;
  failed: boolean;
  inFlight: boolean;
  retrying: boolean;
  onRetry?: (identityKey: string) => void;
  compact?: boolean;
}) {
  if (inFlight || retrying) return <Pill variant="blue" dot>{compact ? '增强中' : '正在增强'}</Pill>;
  if (failed) {
    return compact ? <Pill variant="danger" dot>失败</Pill> : (
      <button type="button" onClick={() => onRetry?.(row.identityKey)} className="inline-flex items-center gap-1 text-[11px] text-[var(--color-danger)] hover:underline">
        <RefreshCw className="h-3 w-3" />重试
      </button>
    );
  }
  if (!refinement) return <Pill variant="neutral">未增强</Pill>;
  if (refinement.payload.status === 'COMPLETE') return <Pill variant="emerald" dot>完整</Pill>;
  return compact ? <Pill variant="warn" dot>有缺口</Pill> : (
    <button type="button" onClick={() => onRetry?.(row.identityKey)} className="inline-flex items-center gap-1 text-[11px] text-[var(--color-warn)] hover:underline">
      <CircleAlert className="h-3 w-3" />有缺口 · 重试
    </button>
  );
}

function EvidenceDialog({
  open,
  onOpenChange,
  row,
  run,
  refinement,
  failed,
  watched,
  watchlistLoaded,
  adding,
  retrying,
  onRetry,
  onAddWatchlist,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  row: ScreeningCandidateRow | null;
  run: ScreeningRunDto;
  refinement?: ScreeningRefinementDto;
  failed: boolean;
  watched: boolean;
  watchlistLoaded: boolean;
  adding: boolean;
  retrying: boolean;
  onRetry: (identityKey: string) => void;
  onAddWatchlist: (row: ScreeningCandidateRow) => Promise<void>;
}) {
  if (!row) return null;
  const refineEntries = Object.entries(refinement?.payload.cells ?? {});
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      ariaLabel={`${row.symbol} 证据`}
      size="lg"
      titleSlot={
        <div className="flex items-center gap-2">
          <Sym>{row.symbol}</Sym>
          <span className="truncate text-[var(--color-fg-2)]">{row.name ?? '名称缺失'}</span>
          <Pill className="ml-auto" variant={refinement?.payload.status === 'COMPLETE' ? 'emerald' : refinement ? 'warn' : 'neutral'}>
            {refinement?.payload.status === 'COMPLETE' ? '增强完整' : refinement ? '部分增强' : '仅初筛'}
          </Pill>
        </div>
      }
    >
      <div className="px-5 py-4">
        <h3 className="m-0 text-[13px] font-medium">初筛命中证据</h3>
        <div className="mt-2 border-y border-[var(--color-border-soft)]">
          {run.query.conditions.map((condition, index) => {
            const cell = metricCell(row, condition.metric);
            return (
              <EvidenceLine
                key={`${condition.metric}-${index}`}
                label={formatCondition(condition)}
                cell={cell}
                currency={row.currency}
                metric={condition.metric}
                passed={row.matchedConditionIndexes.includes(index)}
              />
            );
          })}
        </div>

        <div className="mt-5 flex items-center justify-between gap-3">
          <h3 className="m-0 text-[13px] font-medium">增强证据</h3>
          {refinement && (
            <span className="font-mono text-[10px] text-[var(--color-fg-3)]">
              {formatAsOf(refinement.payload.completedAt)}
            </span>
          )}
        </div>
        {refineEntries.length > 0 ? (
          <div className="mt-2 border-y border-[var(--color-border-soft)]">
            {refineEntries.map(([key, cell]) => (
              <EvidenceLine key={key} label={METRIC_LABELS[key] ?? key} cell={cell} currency={row.currency} metric={key} />
            ))}
          </div>
        ) : (
          <div className="mt-2 border border-[var(--color-border-soft)] px-4 py-5 text-center text-[12px] text-[var(--color-fg-3)]">
            {failed ? '本次增强失败，可以单独重试。' : '这只候选尚未进行证据增强。'}
          </div>
        )}
        {refinement?.payload.warnings.length ? (
          <div className="mt-3 bg-[var(--color-warn-soft)] px-3 py-2.5 text-[11.5px] leading-[1.55] text-[var(--color-warn)]">
            {refinement.payload.warnings.join('；')}
          </div>
        ) : null}
      </div>
      <div className="flex flex-wrap justify-end gap-2 border-t border-[var(--color-border-soft)] px-5 py-3.5">
        {(failed || refinement?.payload.status === 'PARTIAL') && (
          <Button type="button" onClick={() => onRetry(row.identityKey)} disabled={retrying}>
            {retrying ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            重试增强
          </Button>
        )}
        <Button type="button" onClick={() => void onAddWatchlist(row)} disabled={!watchlistLoaded || adding || watched}>
          {adding ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : watched ? <Check className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}
          {watched ? '已在自选' : !watchlistLoaded ? '自选状态加载中' : '加入自选'}
        </Button>
        <Link
          href={stockHref({ symbol: row.symbol, market: run.query.market, name: row.name ?? row.symbol })}
          className="inline-flex h-9 items-center justify-center gap-2 rounded-[var(--radius-btn)] border border-[var(--color-fg)] bg-[var(--color-fg)] px-3.5 text-[13px] font-medium leading-none text-[var(--color-bg)]"
        >
          进入个股
          <ArrowUpRight className="h-3.5 w-3.5" />
        </Link>
      </div>
    </Dialog>
  );
}

function EvidenceLine({
  label,
  cell,
  currency,
  metric,
  passed,
}: {
  label: string;
  cell?: ScreeningMetricCell;
  currency: string;
  metric: string;
  passed?: boolean;
}) {
  const present = cell?.status === 'PRESENT';
  return (
    <div className="grid min-h-14 grid-cols-[minmax(0,1fr)_auto_18px] items-center gap-3 border-b border-[var(--color-border-soft)] py-2.5 last:border-b-0">
      <span className="min-w-0">
        <span className="block text-[12px] text-[var(--color-fg)]">{label}</span>
        <span className="mt-0.5 block truncate font-mono text-[9.5px] text-[var(--color-fg-3)]" title={`${cell?.sourceId ?? '无来源'} · ${cell?.asOf ?? '无日期'}`}>
          {cell?.sourceId ?? '无来源'} · {cell?.asOf ? formatAsOf(cell.asOf) : '无日期'}
          {cell?.estimated ? ' · 估算' : ''}
        </span>
        {cell?.note && <span className="mt-0.5 block text-[10px] text-[var(--color-fg-3)]">{cell.note}</span>}
      </span>
      <MetricValue cell={cell} currency={currency} metric={metric} />
      {passed === false || (!present && passed !== true) ? (
        <CircleAlert className="h-3.5 w-3.5 text-[var(--color-warn)]" />
      ) : (
        <CircleCheck className="h-3.5 w-3.5 text-[var(--color-accent)]" />
      )}
    </div>
  );
}

function CompareDialog({
  open,
  onOpenChange,
  rows,
  run,
  refinements,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  rows: ScreeningCandidateRow[];
  run: ScreeningRunDto;
  refinements: Map<string, ScreeningRefinementDto>;
}) {
  const metrics: Array<[string, (row: ScreeningCandidateRow) => ScreeningMetricCell | undefined]> = [
    ['价格', (row) => metricCell(row, 'PRICE')],
    [METRIC_LABELS[run.query.sort.metric] ?? run.query.sort.metric, (row) => metricCell(row, run.query.sort.metric)],
    ['PE', (row) => refinementCell(refinements.get(row.identityKey), ['PE', 'pe', 'PE_TTM']) ?? metricCell(row, 'PE_TTM')],
    ['PB', (row) => refinementCell(refinements.get(row.identityKey), ['PB', 'pb']) ?? metricCell(row, 'PB')],
    ['ROE', (row) => refinementCell(refinements.get(row.identityKey), ['ROE', 'roe'])],
    ['RSI 14', (row) => refinementCell(refinements.get(row.identityKey), ['RSI14', 'rsi14'])],
  ];
  return (
    <Dialog open={open} onOpenChange={onOpenChange} ariaLabel="候选对比" size="xl" titleSlot={<span>候选对比 · 当前快照</span>}>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[680px] border-collapse text-[12.5px]">
          <thead>
            <tr className="bg-[var(--color-surface-2)]">
              <th className="sticky left-0 z-10 w-[150px] bg-[var(--color-surface-2)] px-4 py-3 text-left font-mono text-[10.5px] font-normal text-[var(--color-fg-2)]">指标</th>
              {rows.map((row) => (
                <th key={row.identityKey} className="min-w-[130px] px-4 py-3 text-left">
                  <Sym>{row.symbol}</Sym>
                  <span className="mt-0.5 block truncate text-[10.5px] font-normal text-[var(--color-fg-3)]">{row.name ?? '名称缺失'}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {metrics.map(([label, read]) => (
              <tr key={label} className="border-t border-[var(--color-border-soft)]">
                <td className="sticky left-0 bg-[var(--color-bg-elev)] px-4 py-3 text-[var(--color-fg-2)]">{label}</td>
                {rows.map((row) => (
                  <td key={row.identityKey} className="px-4 py-3 font-mono">
                    <MetricValue cell={read(row)} currency={row.currency} metric={label === '价格' ? 'PRICE' : label} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="border-t border-[var(--color-border-soft)] px-5 py-3 text-[10.5px] text-[var(--color-fg-3)]">
        只比较当前运行已持久化的同口径证据；缺失值不会被估算为 0。
      </div>
    </Dialog>
  );
}

function MetricValue({ cell, currency, metric }: { cell?: ScreeningMetricCell; currency: string; metric: string }) {
  if (!cell) return <span className="font-mono text-[11.5px] text-[var(--color-fg-3)]">—</span>;
  if (cell.status !== 'PRESENT') {
    return <span className="font-mono text-[10.5px] text-[var(--color-fg-3)]">{cell.value === 'NM' ? 'NM' : statusLabel(cell.status)}</span>;
  }
  if (typeof cell.value === 'string') {
    const value =
      cell.value === 'bullish'
        ? '多头'
        : cell.value === 'bearish'
          ? '空头'
          : cell.value === 'neutral'
            ? '中性'
            : cell.value;
    return <span className="font-mono text-[11.5px]">{value}</span>;
  }
  if (typeof cell.value !== 'number') return <span className="font-mono text-[11.5px] text-[var(--color-fg-3)]">—</span>;
  let value: string;
  if (cell.unit === 'PERCENT') value = `${formatNumber(cell.value * 100, 1)}%`;
  else if (cell.unit === 'RATIO') value = metric.toUpperCase().includes('RSI') ? formatNumber(cell.value, 1) : `${formatNumber(cell.value, 2)}x`;
  else if (cell.unit === 'CURRENCY') value = formatCurrency(cell.value, currency, metric === 'PRICE');
  else if (cell.unit === 'COUNT') value = Math.round(cell.value).toLocaleString('zh-CN');
  else value = String(cell.value);
  return <span className="font-mono text-[11.5px] tabular-nums">{value}</span>;
}

function metricCell(row: ScreeningCandidateRow, metric: string): ScreeningMetricCell | undefined {
  return (row.metrics as Record<string, ScreeningMetricCell | undefined>)[metric];
}

function refinementCell(refinement: ScreeningRefinementDto | undefined, aliases: string[]): ScreeningMetricCell | undefined {
  if (!refinement) return undefined;
  for (const alias of aliases) {
    const cell = refinement.payload.cells[alias];
    if (cell) return cell;
  }
  return undefined;
}

function sortRows(
  rows: ScreeningCandidateRow[],
  run: ScreeningRunDto,
  view: ScreeningView,
  refinements: Map<string, ScreeningRefinementDto>,
): ScreeningCandidateRow[] {
  const sort = view.displaySort;
  if (!sort) return rows;
  const direction = sort.direction === 'ASC' ? 1 : -1;
  return [...rows].sort((left, right) => {
    const a = sortableValue(left, sort.column, run, refinements);
    const b = sortableValue(right, sort.column, run, refinements);
    if (a == null && b == null) return left.symbol.localeCompare(right.symbol);
    if (a == null) return 1;
    if (b == null) return -1;
    if (typeof a === 'string' || typeof b === 'string') return String(a).localeCompare(String(b)) * direction;
    return (a - b) * direction || left.symbol.localeCompare(right.symbol);
  });
}

function sortableValue(
  row: ScreeningCandidateRow,
  column: ScreeningViewColumn,
  run: ScreeningRunDto,
  refinements: Map<string, ScreeningRefinementDto>,
): string | number | null {
  if (column === 'SECURITY') return row.symbol;
  if (column === 'CONDITION_MATCH') return row.matchedConditionIndexes.length;
  if (column === 'REFINE_STATUS') return refinements.get(row.identityKey)?.payload.status === 'COMPLETE' ? 2 : refinements.has(row.identityKey) ? 1 : 0;
  const discoveryMetric = column === 'PRICE' ? 'PRICE' : column === 'SORT_METRIC' ? run.query.sort.metric : column === 'PE' ? 'PE_TTM' : column === 'PB' ? 'PB' : null;
  const cell = discoveryMetric
    ? metricCell(row, discoveryMetric)
    : refinementCell(refinements.get(row.identityKey), column === 'ROE' ? ['ROE', 'roe'] : ['RSI14', 'rsi14']);
  return cell?.status === 'PRESENT' && (typeof cell.value === 'number' || typeof cell.value === 'string') ? cell.value : null;
}

function formatCondition(condition: ScreeningCondition): string {
  const label = METRIC_LABELS[condition.metric] ?? condition.metric;
  const percent = condition.metric === 'REVENUE_GROWTH_YOY' || condition.metric === 'CHANGE_PCT' || condition.metric === 'TURNOVER_RATE';
  const display = (value: number) => formatNumber(percent ? value * 100 : value, 2);
  const suffix = percent ? '%' : '';
  if (condition.operator === 'BETWEEN') return `${label} ${display(condition.min)}–${display(condition.max)}${suffix}`;
  return `${label} ${condition.operator === 'GTE' ? '≥' : '≤'} ${display(condition.value)}${suffix}`;
}

function formatCurrency(value: number, currency: string, precise: boolean): string {
  const symbol = currency === 'USD' ? '$' : currency === 'CNY' ? '¥' : currency === 'HKD' ? 'HK$' : `${currency} `;
  if (precise) return `${symbol}${value.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const absolute = Math.abs(value);
  if (absolute >= 1e12) return `${symbol}${formatNumber(value / 1e12, 2)}万亿`;
  if (absolute >= 1e8) return `${symbol}${formatNumber(value / 1e8, 2)}亿`;
  if (absolute >= 1e4) return `${symbol}${formatNumber(value / 1e4, 2)}万`;
  return `${symbol}${formatNumber(value, 2)}`;
}

function formatNumber(value: number, digits: number): string {
  return value.toLocaleString('zh-CN', { maximumFractionDigits: digits });
}

function statusLabel(status: ScreeningMetricCell['status']): string {
  if (status === 'MISSING') return '缺失';
  if (status === 'NOT_APPLICABLE') return '不适用';
  if (status === 'FETCH_FAILED') return '获取失败';
  return '—';
}

function formatAsOf(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: value.includes('T') ? '2-digit' : undefined,
    minute: value.includes('T') ? '2-digit' : undefined,
  }).format(date);
}
