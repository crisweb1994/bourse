'use client';

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
import {
  isActiveAnalysisType,
  type ActiveAnalysisType,
} from '@bourse/shared-types';
import {
  buildStockAnalysisUrl,
  findOngoingAnalysis,
  INITIAL_LIFECYCLE_STATE,
  isAlreadyRunningError,
  lifecycleReducer,
  type CreatePayload,
} from './stock-analysis-lifecycle-state';

type Stream = ReturnType<typeof useAnalysisStream>;

interface Params {
  stream: Stream;
  effectiveStockId: string | null;
  /** analysisId pinned by the URL (?analysisId=...), or null. */
  analysisId: string | null;
  symbol: string | null;
  router: { replace: (href: string) => void };
  /** Sync the form's default analysis-type to a resolved run. */
  setFormType: (type: ActiveAnalysisType) => void;
  /** Close the new-analysis dialog. */
  closeForm: () => void;
  /** Current form provider/model selection — read by rerun()'s payload. */
  formSettingId: string;
  formModel: string;
}

export function useStockAnalysisLifecycle(params: Params) {
  const [state, dispatch] = useReducer(
    lifecycleReducer,
    INITIAL_LIFECYCLE_STATE,
  );

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
        if (isActiveAnalysisType(analysis.analysisType)) {
          ref.current.setFormType(analysis.analysisType);
        }
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
          const ongoing = findOngoingAnalysis(res.items);
          const target = ongoing ?? res.items[0];
          if (target) {
            dispatch({ t: 'current', analysis: target });
            if (isActiveAnalysisType(target.analysisType)) {
              ref.current.setFormType(target.analysisType);
            }
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
      const cachedOngoing = findOngoingAnalysis(state.recentAnalyses);
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
          const ongoing = findOngoingAnalysis(fresh.items);
          if (ongoing) {
            dispatch({ t: 'recent', items: fresh.items });
            dispatch({ t: 'autoSwitched', analysis: ongoing });
            dispatch({ t: 'current', analysis: ongoing });
            dispatch({ t: 'conflictPending', pending: payload });
            if (isActiveAnalysisType(ongoing.analysisType)) {
              p.setFormType(ongoing.analysisType);
            }
            p.closeForm();
            p.stream.reset();
            p.stream.startStream(ongoing.id);
            p.router.replace(
              buildStockAnalysisUrl({
                symbol: p.symbol,
                stockId: p.effectiveStockId,
                analysisId: ongoing.id,
              }),
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
    if (!isActiveAnalysisType(current.analysisType)) {
      toast.error('该历史分析类型已不支持重新运行');
      return;
    }
    const stockId = p.effectiveStockId;
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
          buildStockAnalysisUrl({
            symbol: p.symbol,
            stockId,
            analysisId: analysis.id,
          }),
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
    const stockId = p.effectiveStockId;
    const id = conflict.id;
    dispatch({ t: 'clearConflict' });
    dispatch({ t: 'current', analysis: conflict });
    if (isActiveAnalysisType(conflict.analysisType)) {
      p.setFormType(conflict.analysisType);
    }
    p.closeForm();
    p.stream.reset();
    p.stream.startStream(id);
    p.router.replace(
      buildStockAnalysisUrl({
        symbol: p.symbol,
        stockId,
        analysisId: id,
      }),
    );
  };

  const cancelAndNew = async (): Promise<void> => {
    const p = ref.current;
    const conflict = state.conflict;
    if (!conflict || !p.effectiveStockId) return;
    const stockId = p.effectiveStockId;
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
            buildStockAnalysisUrl({
              symbol: p.symbol,
              stockId,
              analysisId: analysis.id,
            }),
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
      const stockId = p.effectiveStockId;
      await tryCreateAnalysis(
        replay,
        (analysis) => {
          dispatch({ t: 'current', analysis });
          p.stream.reset();
          p.stream.startStream(analysis.id);
          p.router.replace(
            buildStockAnalysisUrl({
              symbol: p.symbol,
              stockId,
              analysisId: analysis.id,
            }),
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
