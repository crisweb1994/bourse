'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  CopyPlus,
  Database,
  Loader2,
  MoreHorizontal,
  Pencil,
  RefreshCw,
  Save,
  ServerOff,
  SlidersHorizontal,
  Trash2,
} from 'lucide-react';
import type {
  Market,
  SavedScreenDto,
  ScreenerMetric,
  ScreeningCondition,
  ScreeningConfig,
  ScreeningQuery,
  ScreeningRefinementDto,
  ScreeningRunDto,
  ScreeningView,
} from '@bourse/shared-types';
import {
  ApiError,
  addToWatchlist,
  createSavedScreen,
  createScreeningRun,
  deleteSavedScreen,
  getScreeningConfig,
  getScreeningRun,
  getWatchlist,
  listSavedScreens,
  refineScreeningRun,
  updateSavedScreen,
} from '@/lib/api';
import {
  Button,
  Card,
  Dialog,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Input,
  InputShell,
  PageHeader,
  Pill,
  Select,
  SelectOption,
  toast,
  useConfirm,
} from '@/components/ui';
import {
  FilterPanel,
  type ConditionDraft,
} from '@/components/discover/filter-panel';
import { ResultsTable } from '@/components/discover/results-table';
import type { ScreeningCandidateRow } from '@bourse/shared-types';
import { cn } from '@/lib/utils';

const MARKETS: Array<{ value: Market; label: string }> = [
  { value: 'US', label: '美股' },
  { value: 'CN', label: 'A 股' },
  { value: 'HK', label: '港股' },
];

const DEFAULT_VIEW: ScreeningView = {
  visibleColumns: [
    'SECURITY',
    'PRICE',
    'SORT_METRIC',
    'CONDITION_MATCH',
    'PE',
    'PB',
    'ROE',
    'RSI14',
    'REFINE_STATUS',
  ],
};

type SaveDialogState = {
  mode: 'create' | 'copy' | 'rename';
  name: string;
} | null;

export function DiscoverWorkspace() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const confirm = useConfirm();
  const initialRunId = useRef(searchParams.get('runId')).current;
  const initialSavedId = useRef(searchParams.get('savedScreenId')).current;

  const [market, setMarket] = useState<Market>('CN');
  const [config, setConfig] = useState<ScreeningConfig | null>(null);
  const [configLoading, setConfigLoading] = useState(true);
  const [configError, setConfigError] = useState<string | null>(null);
  const [conditions, setConditions] = useState<ConditionDraft[]>([]);
  const [sortMetric, setSortMetric] = useState<ScreenerMetric>('MARKET_CAP');
  const [sortDirection, setSortDirection] = useState<'ASC' | 'DESC'>('DESC');
  const [selectedPresetId, setSelectedPresetId] = useState<string | null>(null);
  const [conditionErrorIndex, setConditionErrorIndex] = useState<number | null>(null);
  const [filterOpen, setFilterOpen] = useState(false);

  const [run, setRun] = useState<ScreeningRunDto | null>(null);
  const [runLoading, setRunLoading] = useState(Boolean(initialRunId));
  const [runLoadError, setRunLoadError] = useState<string | null>(null);
  const [runLoadAttempt, setRunLoadAttempt] = useState(0);
  const [running, setRunning] = useState(false);
  const [view, setView] = useState<ScreeningView>(DEFAULT_VIEW);
  const [refinements, setRefinements] = useState(
    new Map<string, ScreeningRefinementDto>(),
  );
  const [attemptedKeys, setAttemptedKeys] = useState(new Set<string>());
  const [failedKeys, setFailedKeys] = useState(new Set<string>());
  const [inFlightKeys, setInFlightKeys] = useState(new Set<string>());
  const [retryingKeys, setRetryingKeys] = useState(new Set<string>());
  const [refineTarget, setRefineTarget] = useState<25 | 50>(25);
  const [refineRunning, setRefineRunning] = useState(false);
  const refineBusyRef = useRef<number | null>(null);
  const workspaceGenerationRef = useRef(0);

  const [selectedKeys, setSelectedKeys] = useState(new Set<string>());
  const [watchedKeys, setWatchedKeys] = useState(new Set<string>());
  const [watchlistLoaded, setWatchlistLoaded] = useState(false);
  const [addingKeys, setAddingKeys] = useState(new Set<string>());

  const [savedScreens, setSavedScreens] = useState<SavedScreenDto[]>([]);
  const [activeSavedId, setActiveSavedId] = useState<string | null>(initialSavedId);
  const [saveDialog, setSaveDialog] = useState<SaveDialogState>(null);
  const [saving, setSaving] = useState(false);

  const activeSaved = useMemo(
    () => savedScreens.find((item) => item.id === activeSavedId) ?? null,
    [activeSavedId, savedScreens],
  );

  const advanceWorkspace = useCallback(() => {
    const generation = workspaceGenerationRef.current + 1;
    workspaceGenerationRef.current = generation;
    refineBusyRef.current = null;
    return generation;
  }, []);

  const applyRun = useCallback((next: ScreeningRunDto) => {
    const nextRefinements = new Map(
      next.refinements.map((item) => [item.identityKey, item]),
    );
    const restoredKeys = new Set(nextRefinements.keys());
    const target = Math.min(25, next.snapshot.items.length);
    const hasPending = next.snapshot.items
      .slice(0, target)
      .some((row) => !restoredKeys.has(row.identityKey));

    setRun(next);
    setRunLoading(false);
    setRunLoadError(null);
    setRunning(false);
    setMarket(next.query.market);
    setConditions(next.query.conditions.map(conditionToDraft));
    setSortMetric(next.query.sort.metric);
    setSortDirection(next.query.sort.direction);
    setView(next.view);
    setActiveSavedId(next.savedScreenId);
    setSelectedPresetId(null);
    setRefinements(nextRefinements);
    setAttemptedKeys(restoredKeys);
    setFailedKeys(new Set());
    setInFlightKeys(new Set());
    setRetryingKeys(new Set());
    setSelectedKeys(new Set());
    setRefineTarget(25);
    setRefineRunning(hasPending);
  }, []);

  const applySavedScreen = useCallback(
    (saved: SavedScreenDto, updateUrl = true) => {
      advanceWorkspace();
      setActiveSavedId(saved.id);
      setMarket(saved.query.market);
      setConditions(saved.query.conditions.map(conditionToDraft));
      setSortMetric(saved.query.sort.metric);
      setSortDirection(saved.query.sort.direction);
      setView(saved.view);
      setSelectedPresetId(null);
      setRun(null);
      setRunLoading(false);
      setRunLoadError(null);
      setRunning(false);
      setRefinements(new Map());
      setAttemptedKeys(new Set());
      setFailedKeys(new Set());
      setInFlightKeys(new Set());
      setRetryingKeys(new Set());
      setSelectedKeys(new Set());
      setRefineRunning(false);
      if (updateUrl) {
        router.replace(`/discover?savedScreenId=${encodeURIComponent(saved.id)}`);
      }
    },
    [advanceWorkspace, router],
  );

  useEffect(() => {
    let active = true;
    setConfigLoading(true);
    setConfigError(null);
    void getScreeningConfig(market)
      .then((next) => {
        if (!active) return;
        setConfig(next);
      })
      .catch((error) => {
        if (!active) return;
        setConfig(null);
        setConfigError(
          error instanceof ApiError && error.status === 503
            ? '当前市场没有可用的全市场筛选数据源。'
            : '筛选能力加载失败，请稍后重试。',
        );
      })
      .finally(() => active && setConfigLoading(false));
    return () => {
      active = false;
    };
  }, [market]);

  useEffect(() => {
    if (!config?.available || config.market !== market || conditions.length > 0) {
      return;
    }
    const preset = config.presets[0];
    if (preset) {
      setSelectedPresetId(preset.id);
      setConditions(preset.query.conditions.map(conditionToDraft));
      setSortMetric(preset.query.sort.metric);
      setSortDirection(preset.query.sort.direction);
      return;
    }
    const firstMetric = config.metrics[0]?.metric;
    const firstSortMetric = config.sortableMetrics[0];
    setConditions(firstMetric ? [emptyCondition(firstMetric, config)] : []);
    if (firstSortMetric) setSortMetric(firstSortMetric);
  }, [conditions.length, config, market]);

  useEffect(() => {
    let active = true;
    const generation = workspaceGenerationRef.current;
    void listSavedScreens()
      .then((items) => {
        if (!active) return;
        setSavedScreens(items);
        if (!initialRunId && initialSavedId) {
          if (workspaceGenerationRef.current !== generation) return;
          const saved = items.find((item) => item.id === initialSavedId);
          if (saved) {
            applySavedScreen(saved, false);
          } else {
            advanceWorkspace();
            setActiveSavedId(null);
            toast.error('这条已保存筛选不存在或已不可访问');
            router.replace('/discover');
          }
        }
      })
      .catch(() => {
        if (active) toast.error('已保存筛选加载失败');
      });
    return () => {
      active = false;
    };
  }, [advanceWorkspace, applySavedScreen, initialRunId, initialSavedId, router]);

  useEffect(() => {
    let active = true;
    void getWatchlist()
      .then((items) => {
        if (!active) return;
        setWatchedKeys(
          new Set(items.map((item) => `${item.stock.market}:${item.stock.symbol}`)),
        );
        setWatchlistLoaded(true);
      })
      .catch(() => {
        if (active) {
          setWatchlistLoaded(false);
          toast.error('自选状态加载失败');
        }
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!initialRunId) return;
    let active = true;
    const generation = advanceWorkspace();
    setRunLoading(true);
    setRunLoadError(null);
    void getScreeningRun(initialRunId)
      .then((next) => {
        if (!active || workspaceGenerationRef.current !== generation) return;
        applyRun(next);
      })
      .catch((error) => {
        if (!active || workspaceGenerationRef.current !== generation) return;
        if (error instanceof ApiError && error.status === 404) {
          toast.error('这次筛选运行不存在或已不可访问');
          router.replace('/discover');
          return;
        }
        setRunLoadError('筛选运行加载失败，请检查网络后重试。');
      })
      .finally(() => {
        if (active && workspaceGenerationRef.current === generation) {
          setRunLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [advanceWorkspace, applyRun, initialRunId, router, runLoadAttempt]);

  useEffect(() => {
    if (
      !run ||
      !refineRunning ||
      inFlightKeys.size > 0 ||
      refineBusyRef.current !== null
    ) {
      return;
    }
    const candidates = run.snapshot.items.slice(
      0,
      Math.min(refineTarget, run.snapshot.items.length),
    );
    const pending = candidates.filter((row) => !attemptedKeys.has(row.identityKey));
    if (pending.length === 0) {
      setRefineRunning(false);
      return;
    }

    const identityKeys = pending.slice(0, 5).map((row) => row.identityKey);
    const generation = workspaceGenerationRef.current;
    refineBusyRef.current = generation;
    setAttemptedKeys((current) => new Set([...current, ...identityKeys]));
    setInFlightKeys((current) => new Set([...current, ...identityKeys]));

    void refineScreeningRun(run.id, identityKeys)
      .then((response) => {
        if (workspaceGenerationRef.current !== generation) return;
        setRefinements((current) => {
          const next = new Map(current);
          for (const result of response.results) {
            if (result.status !== 'FAILED') {
              next.set(result.identityKey, result.refinement);
            }
          }
          return next;
        });
        setFailedKeys((current) => {
          const next = new Set(current);
          for (const result of response.results) {
            if (result.status === 'FAILED') next.add(result.identityKey);
            else next.delete(result.identityKey);
          }
          return next;
        });
      })
      .catch(() => {
        if (workspaceGenerationRef.current !== generation) return;
        setFailedKeys((current) => new Set([...current, ...identityKeys]));
        setRefineRunning(false);
        toast.error('证据增强批次失败，已保留初筛结果');
      })
      .finally(() => {
        if (refineBusyRef.current === generation) {
          refineBusyRef.current = null;
        }
        if (workspaceGenerationRef.current !== generation) return;
        setInFlightKeys((current) => {
          const next = new Set(current);
          identityKeys.forEach((key) => next.delete(key));
          return next;
        });
      });
  }, [attemptedKeys, inFlightKeys, refineRunning, refineTarget, run]);

  const currentQuery = useCallback((): ScreeningQuery | null => {
    if (!config?.available || conditions.length === 0) return null;
    const parsed: ScreeningCondition[] = [];
    for (const [index, condition] of conditions.entries()) {
      const capability = config.metrics.find((entry) => entry.metric === condition.metric);
      if (!capability || !capability.operators.includes(condition.operator)) {
        setConditionErrorIndex(index);
        toast.error('当前数据源不支持标记的条件');
        return null;
      }
      if (condition.operator === 'BETWEEN') {
        if (!condition.min.trim() || !condition.max.trim()) {
          setConditionErrorIndex(index);
          toast.error('请填写完整的区间上下限');
          return null;
        }
        const min = fromDisplayValue(condition.metric, Number(condition.min));
        const max = fromDisplayValue(condition.metric, Number(condition.max));
        if (!Number.isFinite(min) || !Number.isFinite(max) || min > max) {
          setConditionErrorIndex(index);
          toast.error('筛选区间无效');
          return null;
        }
        parsed.push({ metric: condition.metric, operator: 'BETWEEN', min, max });
      } else {
        if (!condition.value.trim()) {
          setConditionErrorIndex(index);
          toast.error('请填写条件阈值');
          return null;
        }
        const value = fromDisplayValue(condition.metric, Number(condition.value));
        if (!Number.isFinite(value)) {
          setConditionErrorIndex(index);
          toast.error('条件阈值必须是有效数字');
          return null;
        }
        parsed.push({ metric: condition.metric, operator: condition.operator, value });
      }
    }
    if (!config.sortableMetrics.includes(sortMetric)) {
      toast.error('当前数据源不支持所选排序指标');
      return null;
    }
    setConditionErrorIndex(null);
    return {
      market,
      universe: 'ACTIVE_COMMON_STOCKS',
      conditions: parsed,
      sort: { metric: sortMetric, direction: sortDirection },
    };
  }, [conditions, config, market, sortDirection, sortMetric]);

  const handleRun = async () => {
    const query = currentQuery();
    if (!query) return;
    const generation = advanceWorkspace();
    setRunning(true);
    setFilterOpen(false);
    setRefineRunning(false);
    setInFlightKeys(new Set());
    setRetryingKeys(new Set());
    try {
      const next = await createScreeningRun({
        query,
        ...(activeSavedId ? { savedScreenId: activeSavedId } : {}),
      });
      if (workspaceGenerationRef.current !== generation) return;
      applyRun(next);
      router.replace(`/discover?runId=${encodeURIComponent(next.id)}`);
      toast.success(`已冻结 ${next.snapshot.items.length} 只候选`);
    } catch (error) {
      if (workspaceGenerationRef.current !== generation) return;
      const conditionIndex =
        error instanceof ApiError && typeof error.details?.conditionIndex === 'number'
          ? error.details.conditionIndex
          : null;
      setConditionErrorIndex(conditionIndex);
      if (error instanceof ApiError && error.status === 429) {
        const retryAfterMs = error.details?.retryAfterMs;
        toast.error(
          typeof retryAfterMs === 'number'
            ? `数据源限流，请在 ${Math.ceil(retryAfterMs / 1000)} 秒后重试`
            : '数据源限流，请稍后重试',
        );
      } else if (error instanceof ApiError && error.status === 422) {
        toast.error(error.message || '当前数据源不支持这条条件');
      } else {
        toast.error('筛选运行失败，没有生成空结果快照');
      }
    } finally {
      if (workspaceGenerationRef.current === generation) {
        setRunning(false);
      }
    }
  };

  const handleMarketChange = (next: Market) => {
    if (running || next === market) return;
    advanceWorkspace();
    setMarket(next);
    setConditions([]);
    setSortMetric('MARKET_CAP');
    setSortDirection('DESC');
    setConditionErrorIndex(null);
    setRun(null);
    setRunLoading(false);
    setRunLoadError(null);
    setActiveSavedId(null);
    setSelectedPresetId(null);
    setRefinements(new Map());
    setAttemptedKeys(new Set());
    setFailedKeys(new Set());
    setInFlightKeys(new Set());
    setRetryingKeys(new Set());
    setSelectedKeys(new Set());
    setRefineRunning(false);
    router.replace('/discover');
  };

  const applyPreset = (presetId: string) => {
    const preset = config?.presets.find((item) => item.id === presetId);
    if (!preset) return;
    setConditions(preset.query.conditions.map(conditionToDraft));
    setSortMetric(preset.query.sort.metric);
    setSortDirection(preset.query.sort.direction);
    setSelectedPresetId(preset.id);
    setConditionErrorIndex(null);
  };

  const resetConditions = () => {
    const preset = config?.presets[0];
    if (preset) applyPreset(preset.id);
  };

  const addCondition = () => {
    if (!config || conditions.length >= 20) return;
    const metric = config.metrics.find(
      (entry) => !conditions.some((condition) => condition.metric === entry.metric),
    )?.metric ?? config.metrics[0]?.metric;
    if (!metric) return;
    setConditions((current) => [...current, emptyCondition(metric, config)]);
    setSelectedPresetId(null);
  };

  const changeCondition = (index: number, patch: Partial<ConditionDraft>) => {
    setConditions((current) =>
      current.map((condition, itemIndex) =>
        itemIndex === index ? { ...condition, ...patch } : condition,
      ),
    );
    setSelectedPresetId(null);
    setConditionErrorIndex(null);
  };

  const removeCondition = (index: number) => {
    setConditions((current) => current.filter((_, itemIndex) => itemIndex !== index));
    setSelectedPresetId(null);
    setConditionErrorIndex(null);
  };

  const toggleSelected = (identityKey: string, selected: boolean) => {
    setSelectedKeys((current) => {
      const next = new Set(current);
      if (selected) {
        if (next.size >= 5) {
          toast.error('候选对比最多选择 5 只');
          return current;
        }
        next.add(identityKey);
      } else {
        next.delete(identityKey);
      }
      return next;
    });
  };

  const retryRefinement = async (identityKey: string) => {
    if (!run || retryingKeys.has(identityKey)) return;
    const generation = workspaceGenerationRef.current;
    setRetryingKeys((current) => new Set(current).add(identityKey));
    try {
      const response = await refineScreeningRun(run.id, [identityKey]);
      if (workspaceGenerationRef.current !== generation) return;
      const result = response.results[0];
      if (!result || result.status === 'FAILED') {
        setFailedKeys((current) => new Set(current).add(identityKey));
        toast.error('这只候选增强失败，请稍后重试');
        return;
      }
      setRefinements((current) => new Map(current).set(identityKey, result.refinement));
      setFailedKeys((current) => {
        const next = new Set(current);
        next.delete(identityKey);
        return next;
      });
      setAttemptedKeys((current) => new Set(current).add(identityKey));
      toast.success(`${identityKey.split(':').at(-1)} 证据已更新`);
    } catch {
      if (workspaceGenerationRef.current !== generation) return;
      setFailedKeys((current) => new Set(current).add(identityKey));
      toast.error('增强请求失败，请稍后重试');
    } finally {
      if (workspaceGenerationRef.current !== generation) return;
      setRetryingKeys((current) => {
        const next = new Set(current);
        next.delete(identityKey);
        return next;
      });
    }
  };

  const addCandidateToWatchlist = async (row: ScreeningCandidateRow) => {
    if (!run || !watchlistLoaded || addingKeys.has(row.identityKey)) return;
    setAddingKeys((current) => new Set(current).add(row.identityKey));
    try {
      await addToWatchlist({
        symbol: row.symbol,
        name: row.name ?? row.symbol,
        market: run.query.market,
        exchange: row.exchange ?? '',
        currency: row.currency,
      });
      setWatchedKeys((current) => new Set(current).add(row.identityKey));
      window.dispatchEvent(new Event('watchlist:changed'));
      toast.success(`已加入自选 · ${row.symbol}`);
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        setWatchedKeys((current) => new Set(current).add(row.identityKey));
        toast.info(`${row.symbol} 已在自选股中`);
      } else {
        toast.error(`${row.symbol} 加入自选失败`);
      }
    } finally {
      setAddingKeys((current) => {
        const next = new Set(current);
        next.delete(row.identityKey);
        return next;
      });
    }
  };

  const saveCurrent = async () => {
    if (!activeSaved) {
      setSaveDialog({ mode: 'create', name: '' });
      return;
    }
    const query = currentQuery();
    if (!query) return;
    setSaving(true);
    try {
      const updated = await updateSavedScreen(activeSaved.id, { query, view });
      setSavedScreens((current) =>
        current.map((item) => (item.id === updated.id ? updated : item)),
      );
      toast.success(`已保存 · ${updated.name}`);
    } catch {
      toast.error('保存筛选失败');
    } finally {
      setSaving(false);
    }
  };

  const submitSaveDialog = async () => {
    if (!saveDialog) return;
    const name = saveDialog.name.trim();
    if (!name || name.length > 60) {
      toast.error('名称需要 1–60 个字符');
      return;
    }
    const query = currentQuery();
    if (!query && saveDialog.mode !== 'rename') return;
    setSaving(true);
    try {
      if (saveDialog.mode === 'rename' && activeSaved) {
        const updated = await updateSavedScreen(activeSaved.id, { name });
        setSavedScreens((current) =>
          current.map((item) => (item.id === updated.id ? updated : item)),
        );
        toast.success('筛选已重命名');
      } else if (query) {
        const created = await createSavedScreen({ name, query, view });
        setSavedScreens((current) => [created, ...current]);
        setActiveSavedId(created.id);
        router.replace(`/discover?savedScreenId=${encodeURIComponent(created.id)}`);
        toast.success(saveDialog.mode === 'copy' ? '副本已保存' : '筛选已保存');
      }
      setSaveDialog(null);
    } catch {
      toast.error('保存筛选失败');
    } finally {
      setSaving(false);
    }
  };

  const removeSaved = async () => {
    if (!activeSaved) return;
    const accepted = await confirm({
      title: `删除“${activeSaved.name}”？`,
      description: '只删除保存的条件，不影响已经冻结的历史运行。',
      confirmText: '删除',
      danger: true,
    });
    if (!accepted) return;
    try {
      await deleteSavedScreen(activeSaved.id);
      setSavedScreens((current) => current.filter((item) => item.id !== activeSaved.id));
      setActiveSavedId(null);
      router.replace('/discover');
      toast.success('已删除保存筛选');
    } catch {
      toast.error('删除失败，请重试');
    }
  };

  const unavailable = !configLoading && (!config?.available || Boolean(configError));

  return (
    <>
      <PageHeader
        tag="DISCOVER · 候选发现"
        title="研究筛选器"
        subtitle="用可核验条件缩小候选，再进入自选与单股研究。初筛值、来源和数据日期始终保留。"
        className="mb-7"
      />

      <div className="mb-5 flex flex-wrap items-center gap-2 border-y border-[var(--color-border-soft)] py-3">
        <div className="flex rounded-[var(--radius-btn)] border border-[var(--color-border)] bg-[var(--color-bg-elev)] p-0.5" aria-label="市场">
          {MARKETS.map((item) => (
            <button
              key={item.value}
              type="button"
              onClick={() => handleMarketChange(item.value)}
              disabled={running}
              className={cn(
                'h-8 min-w-14 rounded-[5px] px-3 text-[12px] font-medium transition-colors disabled:pointer-events-none disabled:opacity-50',
                market === item.value
                  ? 'bg-[var(--color-fg)] text-[var(--color-bg)]'
                  : 'text-[var(--color-fg-2)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-fg)]',
              )}
              aria-pressed={market === item.value}
            >
              {item.label}
            </button>
          ))}
        </div>

        {configLoading ? (
          <span className="inline-flex items-center gap-1.5 text-[11px] text-[var(--color-fg-3)]">
            <Loader2 className="h-3 w-3 animate-spin" /> 检查数据源
          </span>
        ) : config?.available ? (
          <>
            <Pill variant="emerald" dot>{config.sourceId}</Pill>
            <span className="font-mono text-[10.5px] text-[var(--color-fg-3)]">
              {delayLabel(config.delay)} · {config.universeLabel}
            </span>
          </>
        ) : (
          <Pill variant="warn" dot>筛选源不可用</Pill>
        )}

        <Button
          type="button"
          size="sm"
          className="ml-auto lg:hidden"
          onClick={() => setFilterOpen(true)}
          disabled={running}
        >
          <SlidersHorizontal className="h-3.5 w-3.5" />
          条件
        </Button>

        <Select
          value={activeSavedId ?? '__none__'}
          onValueChange={(value) => {
            if (value === '__none__') {
              setActiveSavedId(null);
              router.replace('/discover');
              return;
            }
            const saved = savedScreens.find((item) => item.id === value);
            if (saved) applySavedScreen(saved);
          }}
          className="h-8 w-full sm:w-[190px]"
          sans
          ariaLabel="已保存筛选"
          disabled={running}
        >
          <SelectOption value="__none__">未保存筛选</SelectOption>
          {savedScreens.map((saved) => (
            <SelectOption key={saved.id} value={saved.id}>{saved.name}</SelectOption>
          ))}
        </Select>

        <Button type="button" size="sm" onClick={() => void saveCurrent()} disabled={running || saving || unavailable}>
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
          保存
        </Button>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" size="icon" disabled={running || !activeSaved} aria-label="管理已保存筛选">
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuLabel>{activeSaved?.name}</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => activeSaved && setSaveDialog({ mode: 'rename', name: activeSaved.name })}>
              <Pencil className="h-3.5 w-3.5" />重命名
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => activeSaved && setSaveDialog({ mode: 'copy', name: `${activeSaved.name} 副本` })}>
              <CopyPlus className="h-3.5 w-3.5" />保存副本
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem danger onSelect={() => void removeSaved()}>
              <Trash2 className="h-3.5 w-3.5" />删除
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="grid min-w-0 gap-5 lg:grid-cols-[320px_minmax(0,1fr)]">
        <FilterPanel
          open={filterOpen}
          config={config}
          conditions={conditions}
          sortMetric={sortMetric}
          sortDirection={sortDirection}
          selectedPresetId={selectedPresetId}
          errorIndex={conditionErrorIndex}
          running={running}
          onClose={() => setFilterOpen(false)}
          onChangeCondition={changeCondition}
          onRemoveCondition={removeCondition}
          onAddCondition={addCondition}
          onApplyPreset={applyPreset}
          onReset={resetConditions}
          onChangeSortMetric={(metric) => {
            setSortMetric(metric);
            setSelectedPresetId(null);
          }}
          onChangeSortDirection={(direction) => {
            setSortDirection(direction);
            setSelectedPresetId(null);
          }}
          onRun={() => void handleRun()}
        />

        <div className="min-w-0">
          {runLoading ? (
            <LoadingResults />
          ) : running ? (
            <RunningResults />
          ) : run ? (
            <ResultsTable
              run={run}
              view={view}
              refinements={refinements}
              selectedKeys={selectedKeys}
              failedKeys={failedKeys}
              inFlightKeys={inFlightKeys}
              watchedKeys={watchedKeys}
              watchlistLoaded={watchlistLoaded}
              addingKeys={addingKeys}
              retryingKeys={retryingKeys}
              refineTarget={refineTarget}
              refineRunning={refineRunning}
              refineAttemptedCount={run.snapshot.items.slice(0, Math.min(refineTarget, run.snapshot.items.length)).filter((row) => attemptedKeys.has(row.identityKey)).length}
              onChangeView={setView}
              onToggleSelected={toggleSelected}
              onClearSelection={() => setSelectedKeys(new Set())}
              onToggleRefine={() => setRefineRunning((current) => !current)}
              onExtendRefine={() => {
                setRefineTarget(50);
                setRefineRunning(true);
              }}
              onRetry={(identityKey) => void retryRefinement(identityKey)}
              onAddWatchlist={addCandidateToWatchlist}
            />
          ) : runLoadError ? (
            <RunLoadErrorResults
              message={runLoadError}
              onRetry={() => setRunLoadAttempt((current) => current + 1)}
            />
          ) : configLoading ? (
            <LoadingResults />
          ) : unavailable ? (
            <UnavailableResults
              market={market}
              message={configError ?? config?.unavailableReason ?? null}
            />
          ) : (
            <ResultsTable
              run={run}
              view={view}
              refinements={refinements}
              selectedKeys={selectedKeys}
              failedKeys={failedKeys}
              inFlightKeys={inFlightKeys}
              watchedKeys={watchedKeys}
              watchlistLoaded={watchlistLoaded}
              addingKeys={addingKeys}
              retryingKeys={retryingKeys}
              refineTarget={refineTarget}
              refineRunning={refineRunning}
              refineAttemptedCount={0}
              onChangeView={setView}
              onToggleSelected={toggleSelected}
              onClearSelection={() => setSelectedKeys(new Set())}
              onToggleRefine={() => setRefineRunning((current) => !current)}
              onExtendRefine={() => {
                setRefineTarget(50);
                setRefineRunning(true);
              }}
              onRetry={(identityKey) => void retryRefinement(identityKey)}
              onAddWatchlist={addCandidateToWatchlist}
            />
          )}
        </div>
      </div>

      <Dialog
        open={Boolean(saveDialog)}
        onOpenChange={(open) => !open && setSaveDialog(null)}
        ariaLabel="保存筛选"
        size="sm"
        titleSlot={saveDialog?.mode === 'rename' ? '重命名筛选' : saveDialog?.mode === 'copy' ? '保存筛选副本' : '保存筛选'}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submitSaveDialog();
          }}
        >
          <div className="px-5 py-4">
            <label htmlFor="saved-screen-name" className="mb-2 block text-[12px] font-medium text-[var(--color-fg-2)]">名称</label>
            <InputShell sans>
              <Input
                id="saved-screen-name"
                autoFocus
                maxLength={60}
                value={saveDialog?.name ?? ''}
                onChange={(event) =>
                  setSaveDialog((current) => current ? { ...current, name: event.target.value } : current)
                }
                placeholder="例如：盈利增长"
              />
            </InputShell>
            <p className="mb-0 mt-2 text-[10.5px] text-[var(--color-fg-3)]">
              保存当前市场、条件、初筛排序与显示列。
            </p>
          </div>
          <div className="flex justify-end gap-2 border-t border-[var(--color-border-soft)] px-5 py-3.5">
            <Button type="button" onClick={() => setSaveDialog(null)}>取消</Button>
            <Button type="submit" variant="primary" disabled={saving}>
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
              保存
            </Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}

function LoadingResults() {
  return (
    <Card className="min-h-[480px]">
      <div className="animate-pulse px-5 py-5">
        <div className="h-4 w-36 bg-[var(--color-surface-2)]" />
        <div className="mt-5 flex gap-2 overflow-hidden">
          {[0, 1, 2, 3].map((item) => <div key={item} className="h-14 w-36 shrink-0 bg-[var(--color-surface-2)]" />)}
        </div>
        <div className="mt-7 h-9 w-64 bg-[var(--color-surface-2)]" />
        <div className="mt-4 space-y-2">
          {[0, 1, 2, 3, 4].map((item) => <div key={item} className="h-11 bg-[var(--color-surface-2)]" />)}
        </div>
      </div>
    </Card>
  );
}

function RunningResults() {
  return (
    <Card className="min-h-[480px]">
      <div className="grid min-h-[480px] place-items-center px-6 text-center">
        <div className="max-w-[360px]">
          <span className="mx-auto grid h-10 w-10 place-items-center rounded-full border border-[var(--color-accent-line)] bg-[var(--color-accent-soft)] text-[var(--color-accent-600)]">
            <Loader2 className="h-4 w-4 animate-spin" />
          </span>
          <h2 className="mb-0 mt-4 text-[15px] font-medium">正在执行全市场初筛</h2>
          <p className="mb-0 mt-2 text-[12.5px] leading-[1.6] text-[var(--color-fg-2)]">
            校验条件、读取 provider 分页并冻结最多 200 只候选。请求失败时不会显示成 0 只。
          </p>
        </div>
      </div>
    </Card>
  );
}

function RunLoadErrorResults({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <Card className="min-h-[480px]">
      <div className="grid min-h-[480px] place-items-center px-6 text-center">
        <div className="max-w-[380px]">
          <span className="mx-auto grid h-10 w-10 place-items-center rounded-full border border-[var(--color-warn-line)] bg-[var(--color-warn-soft)] text-[var(--color-warn)]">
            <ServerOff className="h-4.5 w-4.5" strokeWidth={1.5} />
          </span>
          <h2 className="mb-0 mt-4 text-[16px] font-medium">历史运行暂时无法加载</h2>
          <p className="mb-0 mt-2 text-[13px] leading-[1.6] text-[var(--color-fg-2)]">
            {message}
          </p>
          <Button type="button" className="mt-4" onClick={onRetry}>
            <RefreshCw className="h-3.5 w-3.5" />
            重试加载
          </Button>
        </div>
      </div>
    </Card>
  );
}

function UnavailableResults({ market, message }: { market: Market; message: string | null }) {
  return (
    <Card className="min-h-[480px]">
      <div className="grid min-h-[480px] place-items-center px-6 text-center">
        <div className="max-w-[430px]">
          <span className="mx-auto grid h-10 w-10 place-items-center rounded-full border border-[var(--color-warn-line)] bg-[var(--color-warn-soft)] text-[var(--color-warn)]">
            <ServerOff className="h-4.5 w-4.5" strokeWidth={1.5} />
          </span>
          <h2 className="mb-0 mt-4 text-[16px] font-medium">{market} 市场暂不可筛选</h2>
          <p className="mb-0 mt-2 text-[13px] leading-[1.6] text-[var(--color-fg-2)]">
            {message ?? '当前实例没有配置覆盖全市场的筛选数据源。单股搜索、自选和研究功能仍可正常使用。'}
          </p>
          <div className="mt-4 inline-flex items-center gap-2 border border-[var(--color-border-soft)] bg-[var(--color-surface-2)] px-3 py-2 font-mono text-[10.5px] text-[var(--color-fg-2)]">
            <Database className="h-3.5 w-3.5" />
            需要 bulk screener / full-market snapshot capability
          </div>
        </div>
      </div>
    </Card>
  );
}

function conditionToDraft(condition: ScreeningCondition): ConditionDraft {
  return condition.operator === 'BETWEEN'
    ? {
        metric: condition.metric,
        operator: condition.operator,
        value: '',
        min: String(toDisplayValue(condition.metric, condition.min)),
        max: String(toDisplayValue(condition.metric, condition.max)),
      }
    : {
        metric: condition.metric,
        operator: condition.operator,
        value: String(toDisplayValue(condition.metric, condition.value)),
        min: '',
        max: '',
      };
}

function emptyCondition(metric: ScreenerMetric, config: ScreeningConfig): ConditionDraft {
  const operator = config.metrics.find((entry) => entry.metric === metric)?.operators[0] ?? 'GTE';
  return { metric, operator, value: '0', min: '0', max: '0' };
}

function delayLabel(delay: ScreeningConfig['delay']): string {
  if (delay === 'realtime') return '实时';
  if (delay === 'delayed') return '延迟';
  if (delay === 'eod') return '日终';
  return '时点未知';
}

function isPercentMetric(metric: ScreenerMetric): boolean {
  return metric === 'REVENUE_GROWTH_YOY' || metric === 'CHANGE_PCT' || metric === 'TURNOVER_RATE';
}

function toDisplayValue(metric: ScreenerMetric, value: number): number {
  return isPercentMetric(metric) ? value * 100 : value;
}

function fromDisplayValue(metric: ScreenerMetric, value: number): number {
  return isPercentMetric(metric) ? value / 100 : value;
}
