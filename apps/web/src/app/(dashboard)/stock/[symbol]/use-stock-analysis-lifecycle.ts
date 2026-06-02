'use client';

/**
 * useStockAnalysisLifecycle — the single source of truth for "which analysis
 * is this page showing, and how do we create/switch/resolve runs".
 *
 * Consolidates what used to be ~7 useState + 3 effects + 6 handlers scattered
 * in page.tsx:
 *   - recentAnalyses / currentAnalysisMeta / checkingOngoing / loading
 *   - the conflict machinery (conflictAnalysis / conflictPending /
 *     autoSwitchedFrom)
 *   - the analysisId loader, the history loader, the terminal meta-sync
 *   - create / rerun / retry / view-ongoing / cancel-and-new
 *
 * Behaviour is preserved 1:1 from the previous in-component logic — the state
 * is now a single reducer and the mutable inputs (stream / router / form
 * setters) are read through a ref so the load effects stay keyed only on
 * (effectiveStockId, analysisId) without stale-closure hazards.
 */
import { useEffect, useReducer, useRef } from 'react';
import {
  abortAnalysis,
  createAnalysis,
  getAnalysis,
  getAnalysisHistory,
  retrySection as apiRetrySection,
  type AnalysisDto,
} from '@/lib/api';
import { toast } from '@/components/ui';
import type { useAnalysisStream } from '@/hooks/use-analysis-stream';

export type CreatePayload = {
  type: string;
  settingId?: string;
  model?: string;
};

type Stream = ReturnType<typeof useAnalysisStream>;

interface LifecycleState {
  recentAnalyses: AnalysisDto[];
  current: AnalysisDto | null;
  checkingOngoing: boolean;
  loading: boolean;
  conflict: AnalysisDto | null;
  conflictPending: CreatePayload | null;
  autoSwitchedFrom: AnalysisDto | null;
}

const INITIAL_STATE: LifecycleState = {
  recentAnalyses: [],
  current: null,
  checkingOngoing: true,
  loading: false,
  conflict: null,
  conflictPending: null,
  autoSwitchedFrom: null,
};

type Action =
  | { t: 'checking'; v: boolean }
  | { t: 'loading'; v: boolean }
  | { t: 'recent'; items: AnalysisDto[] }
  | { t: 'current'; analysis: AnalysisDto | null }
  | { t: 'conflict'; analysis: AnalysisDto | null; pending: CreatePayload | null }
  | { t: 'clearConflict' }
  | { t: 'conflictPending'; pending: CreatePayload | null }
  | { t: 'autoSwitched'; analysis: AnalysisDto | null }
  | { t: 'markCancelled'; id: string };

function reducer(s: LifecycleState, a: Action): LifecycleState {
  switch (a.t) {
    case 'checking':
      return { ...s, checkingOngoing: a.v };
    case 'loading':
      return { ...s, loading: a.v };
    case 'recent':
      return { ...s, recentAnalyses: a.items };
    case 'current':
      return { ...s, current: a.analysis };
    case 'conflict':
      return { ...s, conflict: a.analysis, conflictPending: a.pending };
    case 'clearConflict':
      return { ...s, conflict: null, conflictPending: null };
    case 'conflictPending':
      return { ...s, conflictPending: a.pending };
    case 'autoSwitched':
      return { ...s, autoSwitchedFrom: a.analysis };
    case 'markCancelled':
      return {
        ...s,
        recentAnalyses: s.recentAnalyses.map((x) =>
          x.id === a.id ? { ...x, status: 'CANCELLED' } : x,
        ),
      };
    default:
      return s;
  }
}

const findOngoing = (items: AnalysisDto[]): AnalysisDto | undefined =>
  items.find((a) => a.status === 'IN_PROGRESS' || a.status === 'PENDING');

const isAlreadyRunningError = (err: unknown): boolean => {
  if (!(err instanceof Error)) return false;
  const m = err.message.toLowerCase();
  return m.includes('already running') || m.includes('already in progress');
};

interface Params {
  stream: Stream;
  effectiveStockId: string | null;
  /** analysisId pinned by the URL (?analysisId=...), or null. */
  analysisId: string | null;
  symbol: string | null;
  router: { replace: (href: string) => void };
  /** Sync the form's default analysis-type to a resolved run. */
  setFormType: (type: string) => void;
  /** Close the new-analysis dialog. */
  closeForm: () => void;
  /** Current form provider/model selection — read by rerun()'s payload. */
  formSettingId: string;
  formModel: string;
}

export function useStockAnalysisLifecycle(params: Params) {
  const [state, dispatch] = useReducer(reducer, INITIAL_STATE);

  // Mutable inputs read through a ref so the load effects can stay keyed on
  // (effectiveStockId, analysisId) only — no stale-closure on stream/router/
  // form setters, no needless re-runs when those identities change.
  const ref = useRef(params);
  ref.current = params;

  // currentAnalysisMeta mirror for the terminal meta-sync guard.
  const currentRef = useRef<AnalysisDto | null>(null);
  currentRef.current = state.current;

  const { effectiveStockId, analysisId } = params;

  // ---- analysisId loader: URL pins a specific run --------------------------
  useEffect(() => {
    if (!analysisId) return;
    const { stream } = ref.current;
    // Switch to a different analysisId even if one is already loaded — reset
    // the stream so the new id triggers a clean load.
    if (stream.analysisId && stream.analysisId !== analysisId) {
      stream.reset();
      dispatch({ t: 'current', analysis: null });
    } else if (stream.status !== 'idle' && stream.analysisId === analysisId) {
      return; // same id already loaded — do not re-fetch
    }
    let cancelled = false;
    dispatch({ t: 'checking', v: true });
    getAnalysis(analysisId)
      .then((analysis) => {
        if (cancelled) return;
        ref.current.setFormType(analysis.analysisType);
        dispatch({ t: 'current', analysis });
        ref.current.stream.startStream(analysisId);
      })
      .catch(() => {
        if (!cancelled) ref.current.stream.startStream(analysisId);
      })
      .finally(() => {
        if (!cancelled) dispatch({ t: 'checking', v: false });
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [analysisId]);

  // ---- history loader: always cache recent; auto-attach when not pinned ----
  useEffect(() => {
    if (!effectiveStockId) {
      if (!analysisId) dispatch({ t: 'checking', v: false });
      return;
    }
    let cancelled = false;
    if (!analysisId) dispatch({ t: 'checking', v: true });
    getAnalysisHistory(1, 5, { stockId: effectiveStockId })
      .then((res) => {
        if (cancelled) return;
        // Always cache — conflict pre-flight, compare, header chip all read it,
        // including on ?analysisId= deep-links the loader above doesn't fill.
        dispatch({ t: 'recent', items: res.items });
        if (!analysisId) {
          const ongoing = findOngoing(res.items);
          const target = ongoing ?? res.items[0];
          if (target) {
            dispatch({ t: 'current', analysis: target });
            ref.current.setFormType(target.analysisType);
            ref.current.stream.startStream(target.id);
          }
        }
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled && !analysisId) dispatch({ t: 'checking', v: false });
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveStockId, analysisId]);

  // ---- terminal meta-sync: refresh metadata once the run finishes ----------
  const streamStatus = params.stream.status;
  const streamAnalysisId = params.stream.analysisId;
  useEffect(() => {
    if (streamStatus !== 'completed' && streamStatus !== 'error') return;
    if (!streamAnalysisId) return;
    const m = currentRef.current;
    if (
      m?.id === streamAnalysisId &&
      m.status !== 'IN_PROGRESS' &&
      m.status !== 'PENDING'
    ) {
      return; // already hold terminal metadata for this run
    }
    let cancelled = false;
    getAnalysis(streamAnalysisId)
      .then((a) => {
        if (!cancelled) dispatch({ t: 'current', analysis: a });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [streamStatus, streamAnalysisId]);

  // ---- create / conflict ---------------------------------------------------
  const tryCreateAnalysis = async (
    payload: CreatePayload,
    afterSuccess: (analysis: AnalysisDto) => void,
    opts?: { skipPreflight?: boolean },
  ): Promise<boolean> => {
    const p = ref.current;
    if (!p.effectiveStockId) {
      toast.error('缺少股票记录，请先添加到自选股后再进入分析。');
      return false;
    }
    // ③ pre-flight — a cached ongoing run avoids the wasted roundtrip.
    // Skipped on the cancel-and-replay paths: they just aborted the only
    // ongoing run, but the dispatched cancellation isn't visible in this
    // closure's `state` yet, so a pre-flight would re-detect the stale ongoing
    // and re-open the conflict instead of creating. The backend 409 + the ④
    // fallback below still guard against a genuinely concurrent run.
    if (!opts?.skipPreflight) {
      const cachedOngoing = findOngoing(state.recentAnalyses);
      if (cachedOngoing) {
        dispatch({ t: 'conflict', analysis: cachedOngoing, pending: payload });
        return false;
      }
    }
    dispatch({ t: 'loading', v: true });
    try {
      const analysis = await createAnalysis(
        p.effectiveStockId,
        payload.type,
        payload.settingId,
        payload.model,
      );
      dispatch({ t: 'loading', v: false });
      afterSuccess(analysis);
      return true;
    } catch (err: unknown) {
      dispatch({ t: 'loading', v: false });
      // ④ post-error fallback — backend rejected because of a race. Refetch
      // history, find the brand-new ongoing row, auto-switch to it.
      if (isAlreadyRunningError(err)) {
        try {
          const fresh = await getAnalysisHistory(1, 5, {
            stockId: p.effectiveStockId,
          });
          const ongoing = findOngoing(fresh.items);
          if (ongoing) {
            dispatch({ t: 'recent', items: fresh.items });
            dispatch({ t: 'autoSwitched', analysis: ongoing });
            dispatch({ t: 'current', analysis: ongoing });
            dispatch({ t: 'conflictPending', pending: payload });
            p.setFormType(ongoing.analysisType);
            p.closeForm();
            p.stream.reset();
            p.stream.startStream(ongoing.id);
            p.router.replace(
              `/stock/${encodeURIComponent(p.symbol ?? '')}?stockId=${p.effectiveStockId}&analysisId=${ongoing.id}`,
            );
            return false;
          }
        } catch {
          /* fall through to toast */
        }
      }
      toast.error(err instanceof Error ? err.message : '创建分析失败');
      return false;
    }
  };

  const startAnalysis = async (payload: CreatePayload): Promise<boolean> =>
    tryCreateAnalysis(payload, (analysis) => {
      const p = ref.current;
      dispatch({ t: 'current', analysis });
      p.closeForm();
      p.stream.startStream(analysis.id);
    });

  const rerun = async (): Promise<void> => {
    const p = ref.current;
    const current = state.current;
    if (!p.effectiveStockId || !current) return;
    await tryCreateAnalysis(
      {
        type: current.analysisType,
        settingId: p.formSettingId || undefined,
        model: current.aiModel || p.formModel || undefined,
      },
      (analysis) => {
        dispatch({ t: 'current', analysis });
        p.stream.reset();
        p.stream.startStream(analysis.id);
        p.router.replace(
          `/stock/${encodeURIComponent(p.symbol ?? '')}?stockId=${p.effectiveStockId}&analysisId=${analysis.id}`,
        );
      },
    );
  };

  const retrySection = async (sectionId: string): Promise<void> => {
    const { stream } = ref.current;
    if (!stream.analysisId) return;
    try {
      await apiRetrySection(stream.analysisId, sectionId);
      stream.startStream(stream.analysisId);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : '重试失败');
    }
  };

  const viewOngoing = (): void => {
    const p = ref.current;
    const conflict = state.conflict;
    if (!conflict || !p.effectiveStockId) return;
    const id = conflict.id;
    dispatch({ t: 'clearConflict' });
    dispatch({ t: 'current', analysis: conflict });
    p.setFormType(conflict.analysisType);
    p.closeForm();
    p.stream.reset();
    p.stream.startStream(id);
    p.router.replace(
      `/stock/${encodeURIComponent(p.symbol ?? '')}?stockId=${p.effectiveStockId}&analysisId=${id}`,
    );
  };

  const cancelAndNew = async (): Promise<void> => {
    const p = ref.current;
    const conflict = state.conflict;
    if (!conflict || !p.effectiveStockId) return;
    const ongoingId = conflict.id;
    const replay = state.conflictPending;
    dispatch({ t: 'clearConflict' });
    try {
      await abortAnalysis(ongoingId);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : '取消进行中的分析失败');
      return;
    }
    dispatch({ t: 'markCancelled', id: ongoingId });
    if (replay) {
      await tryCreateAnalysis(
        replay,
        (analysis) => {
          dispatch({ t: 'current', analysis });
          p.closeForm();
          p.stream.reset();
          p.stream.startStream(analysis.id);
          p.router.replace(
            `/stock/${encodeURIComponent(p.symbol ?? '')}?stockId=${p.effectiveStockId}&analysisId=${analysis.id}`,
          );
        },
        { skipPreflight: true },
      );
    }
  };

  const dismissConflict = (): void => dispatch({ t: 'clearConflict' });
  const dismissAutoSwitched = (): void =>
    dispatch({ t: 'autoSwitched', analysis: null });

  const cancelAutoSwitchedAndNew = async (): Promise<void> => {
    const p = ref.current;
    const from = state.autoSwitchedFrom;
    if (!from) return;
    const replay = state.conflictPending;
    const id = from.id;
    dispatch({ t: 'autoSwitched', analysis: null });
    try {
      await abortAnalysis(id);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : '取消进行中的分析失败');
      return;
    }
    if (replay && p.effectiveStockId) {
      await tryCreateAnalysis(
        replay,
        (analysis) => {
          dispatch({ t: 'current', analysis });
          p.stream.reset();
          p.stream.startStream(analysis.id);
          p.router.replace(
            `/stock/${encodeURIComponent(p.symbol ?? '')}?stockId=${p.effectiveStockId}&analysisId=${analysis.id}`,
          );
        },
        { skipPreflight: true },
      );
    }
  };

  return {
    recentAnalyses: state.recentAnalyses,
    currentAnalysisMeta: state.current,
    checkingOngoing: state.checkingOngoing,
    loading: state.loading,
    conflictAnalysis: state.conflict,
    autoSwitchedFrom: state.autoSwitchedFrom,
    startAnalysis,
    rerun,
    retrySection,
    viewOngoing,
    cancelAndNew,
    dismissConflict,
    dismissAutoSwitched,
    cancelAutoSwitchedAndNew,
  };
}
