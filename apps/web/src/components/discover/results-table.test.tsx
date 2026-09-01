import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  ScreeningCandidateRow,
  ScreeningMetricCell,
  ScreeningRunDto,
  ScreeningViewColumn,
} from '@bourse/shared-types';
import { ResultsTable } from './results-table';

describe('ResultsTable', () => {
  afterEach(cleanup);

  it('shows bounded provider warnings even for a complete snapshot', () => {
    const run = screeningRun([]);
    run.snapshot.warnings = [
      { code: 'WARN_1', message: '第一条快照提示' },
      { code: 'WARN_2', message: '第二条快照提示' },
      { code: 'WARN_3', message: '第三条快照提示' },
      { code: 'WARN_4', message: '第四条快照提示' },
    ];

    render(<ResultsTable {...resultsProps(run)} />);

    expect(screen.getByText('第一条快照提示')).toBeInTheDocument();
    expect(screen.getByText('第二条快照提示')).toBeInTheDocument();
    expect(screen.getByText('第三条快照提示')).toBeInTheDocument();
    expect(screen.queryByText('第四条快照提示')).not.toBeInTheDocument();
    expect(screen.getByText('另有 1 条快照提示')).toBeInTheDocument();
  });

  it('keeps add-to-watchlist disabled until existing membership is known', () => {
    const run = screeningRun([candidate()]);
    const props = resultsProps(run);
    const { rerender } = render(
      <ResultsTable {...props} watchlistLoaded={false} />,
    );

    expect(
      screen.getByRole('button', { name: 'CN:600000 自选状态加载中' }),
    ).toBeDisabled();

    rerender(<ResultsTable {...props} watchlistLoaded />);

    expect(
      screen.getByRole('button', { name: '将 CN:600000 加入自选' }),
    ).toBeEnabled();
  });

  it('formats large currency values with Chinese units without compacting prices', () => {
    const first = candidate();
    first.metrics.MARKET_CAP = cell(123_456_789, 'CURRENCY');
    first.metrics.PRICE = cell(12.34, 'CURRENCY');
    const firstRun = screeningRun([first], ['SECURITY', 'SORT_METRIC', 'PRICE']);
    const { rerender } = render(<ResultsTable {...resultsProps(firstRun)} />);

    expect(screen.getAllByText('¥1.23亿').length).toBeGreaterThan(0);
    expect(screen.getAllByText('¥12.34').length).toBeGreaterThan(0);

    const second = candidate();
    second.metrics.MARKET_CAP = cell(1_234_567_890_000, 'CURRENCY');
    const secondRun = screeningRun([second], ['SECURITY', 'SORT_METRIC']);
    rerender(<ResultsTable {...resultsProps(secondRun)} />);

    expect(screen.getAllByText('¥1.23万亿').length).toBeGreaterThan(0);
  });
});

function resultsProps(run: ScreeningRunDto) {
  return {
    run,
    view: run.view,
    refinements: new Map(),
    selectedKeys: new Set<string>(),
    failedKeys: new Set<string>(),
    inFlightKeys: new Set<string>(),
    watchedKeys: new Set<string>(),
    watchlistLoaded: true,
    addingKeys: new Set<string>(),
    retryingKeys: new Set<string>(),
    refineTarget: 25 as const,
    refineRunning: false,
    refineAttemptedCount: 0,
    onChangeView: vi.fn(),
    onToggleSelected: vi.fn(),
    onClearSelection: vi.fn(),
    onToggleRefine: vi.fn(),
    onExtendRefine: vi.fn(),
    onRetry: vi.fn(),
    onAddWatchlist: vi.fn().mockResolvedValue(undefined),
  };
}

function screeningRun(
  items: ScreeningCandidateRow[],
  visibleColumns: ScreeningViewColumn[] = ['SECURITY'],
): ScreeningRunDto {
  return {
    id: 'run-1',
    savedScreenId: null,
    status: 'COMPLETE',
    query: {
      market: 'CN',
      universe: 'ACTIVE_COMMON_STOCKS',
      conditions: [{ metric: 'MARKET_CAP', operator: 'GTE', value: 1 }],
      sort: { metric: 'MARKET_CAP', direction: 'DESC' },
    },
    sourceId: 'test-screener',
    capturedAt: '2026-08-22T00:00:00.000Z',
    createdAt: '2026-08-22T00:00:00.000Z',
    snapshot: {
      universeCount: 100,
      matchedCount: items.length,
      providerAsOf: '2026-08-22T00:00:00.000Z',
      complete: true,
      truncated: false,
      warnings: [],
      items,
    },
    view: { visibleColumns },
    refinements: [],
  };
}

function candidate(): ScreeningCandidateRow {
  return {
    identityKey: 'CN:600000',
    symbol: 'CN:600000',
    name: '浦发银行',
    exchange: 'SSE',
    currency: 'CNY',
    metrics: {
      MARKET_CAP: cell(100, 'CURRENCY'),
      NET_INCOME_TTM: cell(10, 'CURRENCY'),
      PE_TTM: cell(8, 'RATIO'),
      PB: cell(1, 'RATIO'),
      REVENUE_GROWTH_YOY: cell(5, 'PERCENT'),
      PRICE: cell(10, 'CURRENCY'),
      CHANGE_PCT: cell(1, 'PERCENT'),
      TURNOVER_RATE: cell(2, 'PERCENT'),
    },
    matchedConditionIndexes: [0],
  };
}

function cell(
  value: number,
  unit: ScreeningMetricCell['unit'],
): ScreeningMetricCell {
  return {
    status: 'PRESENT',
    value,
    unit,
    sourceId: 'test-screener',
    asOf: '2026-08-22T00:00:00.000Z',
    estimated: false,
  };
}
