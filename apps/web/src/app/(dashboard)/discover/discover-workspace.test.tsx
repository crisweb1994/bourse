import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  Market,
  SavedScreenDto,
  ScreenerMetric,
  ScreeningConfig,
  ScreeningQuery,
  ScreeningRefinementDto,
  ScreeningRunDto,
} from '@bourse/shared-types';
import { ApiError } from '@/lib/api';
import { DiscoverWorkspace } from './discover-workspace';

const mocks = vi.hoisted(() => ({
  search: '',
  router: { replace: vi.fn() },
  confirm: vi.fn(),
  toast: {
    error: vi.fn(),
    success: vi.fn(),
    info: vi.fn(),
  },
  api: {
    addToWatchlist: vi.fn(),
    createSavedScreen: vi.fn(),
    createScreeningRun: vi.fn(),
    deleteSavedScreen: vi.fn(),
    getScreeningConfig: vi.fn(),
    getScreeningRun: vi.fn(),
    getWatchlist: vi.fn(),
    listSavedScreens: vi.fn(),
    refineScreeningRun: vi.fn(),
    updateSavedScreen: vi.fn(),
  },
}));

vi.mock('next/navigation', () => ({
  useRouter: () => mocks.router,
  useSearchParams: () => new URLSearchParams(mocks.search),
}));

vi.mock('@/lib/api', () => {
  class MockApiError extends Error {
    constructor(
      public status: number,
      message: string,
      public details?: Record<string, unknown>,
    ) {
      super(message);
    }
  }

  return { ...mocks.api, ApiError: MockApiError };
});

vi.mock('@/components/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/ui')>();
  return {
    ...actual,
    toast: mocks.toast,
    useConfirm: () => mocks.confirm,
  };
});

vi.mock('@/components/discover/filter-panel', () => ({
  FilterPanel: (props: {
    conditions: Array<{ metric: string }>;
    sortMetric: string;
    running: boolean;
    onRun: () => void;
  }) => (
    <div
      data-testid="filter-probe"
      data-metrics={props.conditions.map((condition) => condition.metric).join(',')}
      data-sort={props.sortMetric}
    >
      <button type="button" disabled={props.running} onClick={props.onRun}>
        run-screening-probe
      </button>
    </div>
  ),
}));

vi.mock('@/components/discover/results-table', () => ({
  ResultsTable: (props: {
    run: ScreeningRunDto | null;
    refinements: Map<string, ScreeningRefinementDto>;
    failedKeys: Set<string>;
    retryingKeys: Set<string>;
    onRetry: (identityKey: string) => void;
  }) => {
    const identityKey = props.run?.snapshot.items[0]?.identityKey;
    return (
      <div
        data-testid="results-probe"
        data-run={props.run?.id ?? ''}
        data-refinements={[...props.refinements.values()]
          .flatMap((item) => item.payload.warnings)
          .join(',')}
        data-failed={[...props.failedKeys].join(',')}
        data-retrying={[...props.retryingKeys].join(',')}
      >
        {props.run ? `results:${props.run.id}` : 'results:empty'}
        {identityKey && (
          <button type="button" onClick={() => props.onRetry(identityKey)}>
            retry-refinement-probe
          </button>
        )}
      </div>
    );
  },
}));

describe('DiscoverWorkspace', () => {
  beforeEach(() => {
    mocks.search = '';
    mocks.router.replace.mockReset();
    mocks.confirm.mockReset();
    mocks.confirm.mockResolvedValue(true);
    Object.values(mocks.toast).forEach((mock) => mock.mockReset());
    Object.values(mocks.api).forEach((mock) => mock.mockReset());

    mocks.api.getScreeningConfig.mockImplementation((market: Market) =>
      Promise.resolve(screeningConfig(market)),
    );
    mocks.api.getWatchlist.mockResolvedValue([]);
    mocks.api.listSavedScreens.mockResolvedValue([]);
    mocks.api.refineScreeningRun.mockResolvedValue({ results: [] });
  });

  afterEach(() => {
    cleanup();
  });

  it('keeps a restored run visible when the current provider is unavailable', async () => {
    mocks.search = 'runId=run-1';
    mocks.api.getScreeningConfig.mockResolvedValue(
      screeningConfig('CN', {
        available: false,
        unavailableReason: '当前筛选数据源不允许保存候选快照，因此未启用。',
        sourceId: null,
        metrics: [],
        sortableMetrics: [],
        delay: null,
        presets: [],
      }),
    );
    mocks.api.getScreeningRun.mockResolvedValue(screeningRun('run-1'));

    render(<DiscoverWorkspace />);

    expect(await screen.findByTestId('results-probe')).toHaveAttribute('data-run', 'run-1');
    expect(screen.queryByText('CN 市场暂不可筛选')).not.toBeInTheDocument();
  });

  it('keeps a failed run URL and retries non-404 load errors', async () => {
    mocks.search = 'runId=run-retry';
    mocks.api.getScreeningRun
      .mockRejectedValueOnce(new ApiError(500, 'upstream failed'))
      .mockResolvedValueOnce(screeningRun('run-retry'));

    render(<DiscoverWorkspace />);

    expect(await screen.findByText('历史运行暂时无法加载')).toBeInTheDocument();
    expect(mocks.router.replace).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '重试加载' }));

    await waitFor(() => {
      expect(screen.getByTestId('results-probe')).toHaveAttribute('data-run', 'run-retry');
    });
    expect(mocks.api.getScreeningRun).toHaveBeenCalledTimes(2);
  });

  it('clears the URL only when a restored run returns 404', async () => {
    mocks.search = 'runId=missing-run';
    mocks.api.getScreeningRun.mockRejectedValue(new ApiError(404, 'not found'));

    render(<DiscoverWorkspace />);

    await waitFor(() => expect(mocks.router.replace).toHaveBeenCalledWith('/discover'));
    expect(mocks.toast.error).toHaveBeenCalledWith('这次筛选运行不存在或已不可访问');
    expect(screen.queryByText('历史运行暂时无法加载')).not.toBeInTheDocument();
  });

  it('clears an invalid saved-screen link with feedback', async () => {
    mocks.search = 'savedScreenId=missing-screen';

    render(<DiscoverWorkspace />);

    await waitFor(() => expect(mocks.router.replace).toHaveBeenCalledWith('/discover'));
    expect(mocks.toast.error).toHaveBeenCalledWith('这条已保存筛选不存在或已不可访问');
    expect(screen.getByRole('combobox', { name: '已保存筛选' })).toHaveTextContent('未保存筛选');
  });

  it('preserves unsupported saved conditions and sorting when config resolves later', async () => {
    mocks.search = 'savedScreenId=saved-pb';
    const configRequest = deferred<ScreeningConfig>();
    mocks.api.getScreeningConfig.mockReturnValue(configRequest.promise);
    mocks.api.listSavedScreens.mockResolvedValue([
      savedScreen('saved-pb', screeningQuery('CN', 'PB')),
    ]);

    render(<DiscoverWorkspace />);

    await waitFor(() => {
      expect(screen.getByTestId('filter-probe')).toHaveAttribute('data-metrics', 'PB');
      expect(screen.getByTestId('filter-probe')).toHaveAttribute('data-sort', 'PB');
    });

    configRequest.resolve(screeningConfig('CN'));

    await waitFor(() => {
      expect(screen.getByTestId('filter-probe')).toHaveAttribute('data-metrics', 'PB');
      expect(screen.getByTestId('filter-probe')).toHaveAttribute('data-sort', 'PB');
    });
  });

  it('ignores a restored run that resolves after the market changes', async () => {
    mocks.search = 'runId=old-run';
    const runRequest = deferred<ScreeningRunDto>();
    mocks.api.getScreeningRun.mockReturnValue(runRequest.promise);

    render(<DiscoverWorkspace />);

    fireEvent.click(screen.getByRole('button', { name: '美股' }));
    runRequest.resolve(screeningRun('old-run'));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '美股' })).toHaveAttribute('aria-pressed', 'true');
      expect(screen.getByTestId('results-probe')).toHaveAttribute('data-run', '');
    });
  });

  it('locks market and saved-screen context while creating a run', async () => {
    const createRequest = deferred<ScreeningRunDto>();
    mocks.api.createScreeningRun.mockReturnValue(createRequest.promise);

    render(<DiscoverWorkspace />);

    const runButton = await screen.findByRole('button', { name: 'run-screening-probe' });
    fireEvent.click(runButton);

    await waitFor(() => {
      for (const label of ['美股', 'A 股', '港股']) {
        expect(screen.getByRole('button', { name: label })).toBeDisabled();
      }
      expect(screen.getByRole('combobox', { name: '已保存筛选' })).toBeDisabled();
    });

    createRequest.resolve(screeningRun('new-run'));
    await waitFor(() => {
      expect(screen.getByTestId('results-probe')).toHaveAttribute('data-run', 'new-run');
    });
  });

  it('ignores an automatic refinement that resolves after the market changes', async () => {
    mocks.search = 'runId=old-run';
    const refineRequest = deferred<{
      results: Array<{
        identityKey: string;
        status: 'COMPLETE';
        refinement: ScreeningRefinementDto;
      }>;
    }>();
    mocks.api.getScreeningRun.mockResolvedValue(runWithCandidate('old-run'));
    mocks.api.refineScreeningRun.mockReturnValue(refineRequest.promise);

    render(<DiscoverWorkspace />);

    await waitFor(() => expect(mocks.api.refineScreeningRun).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: '美股' }));
    refineRequest.resolve({
      results: [{
        identityKey: 'CN:600000',
        status: 'COMPLETE',
        refinement: refinement('late-auto'),
      }],
    });

    await waitFor(() => {
      expect(screen.getByTestId('results-probe')).toHaveAttribute('data-run', '');
      expect(screen.getByTestId('results-probe')).toHaveAttribute('data-refinements', '');
      expect(screen.getByTestId('results-probe')).toHaveAttribute('data-failed', '');
    });
  });

  it('ignores a manual retry that resolves after the market changes', async () => {
    mocks.search = 'runId=old-run';
    const refineRequest = deferred<{
      results: Array<{
        identityKey: string;
        status: 'COMPLETE';
        refinement: ScreeningRefinementDto;
      }>;
    }>();
    const restored = runWithCandidate('old-run');
    restored.refinements = [refinement('restored')];
    mocks.api.getScreeningRun.mockResolvedValue(restored);
    mocks.api.refineScreeningRun.mockReturnValue(refineRequest.promise);

    render(<DiscoverWorkspace />);

    const retry = await screen.findByRole('button', {
      name: 'retry-refinement-probe',
    });
    fireEvent.click(retry);
    await waitFor(() => expect(mocks.api.refineScreeningRun).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: '美股' }));
    refineRequest.resolve({
      results: [{
        identityKey: 'CN:600000',
        status: 'COMPLETE',
        refinement: refinement('late-retry'),
      }],
    });

    await waitFor(() => {
      expect(screen.getByTestId('results-probe')).toHaveAttribute('data-run', '');
      expect(screen.getByTestId('results-probe')).toHaveAttribute('data-refinements', '');
      expect(screen.getByTestId('results-probe')).toHaveAttribute('data-retrying', '');
    });
  });
});

function screeningConfig(
  market: Market,
  overrides: Partial<ScreeningConfig> = {},
): ScreeningConfig {
  const presetQuery = screeningQuery(market, 'MARKET_CAP');
  return {
    market,
    available: true,
    unavailableReason: null,
    sourceId: 'test-screener',
    metrics: [{ metric: 'MARKET_CAP', operators: ['GTE', 'LTE', 'BETWEEN'] }],
    sortableMetrics: ['MARKET_CAP'],
    delay: 'delayed',
    universeLabel: '测试股票池',
    universeRules: [],
    presets: [{ id: 'default', name: '默认', description: '默认', query: presetQuery }],
    ...overrides,
  };
}

function screeningQuery(
  market: Market,
  metric: ScreenerMetric,
): ScreeningQuery {
  return {
    market,
    universe: 'ACTIVE_COMMON_STOCKS',
    conditions: [{ metric, operator: 'GTE', value: 1 }],
    sort: { metric, direction: 'DESC' },
  };
}

function savedScreen(id: string, query: ScreeningQuery): SavedScreenDto {
  return {
    id,
    name: '测试筛选',
    query,
    view: { visibleColumns: ['SECURITY'] },
    createdAt: '2026-08-22T00:00:00.000Z',
    updatedAt: '2026-08-22T00:00:00.000Z',
  };
}

function screeningRun(
  id: string,
  query: ScreeningQuery = screeningQuery('CN', 'MARKET_CAP'),
): ScreeningRunDto {
  return {
    id,
    savedScreenId: null,
    status: 'COMPLETE',
    query,
    sourceId: 'test-screener',
    capturedAt: '2026-08-22T00:00:00.000Z',
    createdAt: '2026-08-22T00:00:00.000Z',
    snapshot: {
      universeCount: 100,
      matchedCount: 0,
      providerAsOf: '2026-08-22T00:00:00.000Z',
      complete: true,
      truncated: false,
      warnings: [],
      items: [],
    },
    view: { visibleColumns: ['SECURITY'] },
    refinements: [],
  };
}

function runWithCandidate(id: string): ScreeningRunDto {
  const run = screeningRun(id);
  run.snapshot.matchedCount = 1;
  run.snapshot.items = [
    {
      identityKey: 'CN:600000',
      symbol: '600000',
      name: '浦发银行',
      exchange: 'SSE',
      currency: 'CNY',
      metrics: {
        MARKET_CAP: metricCell(100, 'CURRENCY'),
        NET_INCOME_TTM: metricCell(10, 'CURRENCY'),
        PE_TTM: metricCell(8, 'RATIO'),
        PB: metricCell(1, 'RATIO'),
        REVENUE_GROWTH_YOY: metricCell(0.05, 'PERCENT'),
        PRICE: metricCell(10, 'CURRENCY'),
        CHANGE_PCT: metricCell(0.01, 'PERCENT'),
        TURNOVER_RATE: metricCell(0.02, 'PERCENT'),
      },
      matchedConditionIndexes: [0],
    },
  ];
  return run;
}

function metricCell(
  value: number,
  unit: 'RATIO' | 'PERCENT' | 'CURRENCY',
) {
  return {
    status: 'PRESENT' as const,
    value,
    unit,
    sourceId: 'test-screener',
    asOf: '2026-08-22T00:00:00.000Z',
    estimated: false,
  };
}

function refinement(warning: string): ScreeningRefinementDto {
  return {
    identityKey: 'CN:600000',
    payload: {
      status: 'COMPLETE',
      cells: {},
      warnings: [warning],
      completedAt: '2026-08-22T01:00:00.000Z',
    },
    createdAt: '2026-08-22T01:00:00.000Z',
    updatedAt: '2026-08-22T01:00:00.000Z',
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
