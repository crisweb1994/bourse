'use client';

import { useEffect, useReducer, useRef } from 'react';
import {
  createAnalysis,
  getAnalysis,
  getAnalysisHistory,
  retryAnalysis as apiRetryAnalysis,
  type AnalysisDto,
  type AnalysisHistoryItemDto,
} from '@/lib/api';
import { toast } from '@/components/ui';
import type { useAnalysisStream } from '@/hooks/use-analysis-stream';
import {
  buildStockAnalysisUrl,
  findOngoingAnalysis,
  INITIAL_LIFECYCLE_STATE,
  lifecycleReducer,
  type CreatePayload,
} from './stock-analysis-lifecycle-state';

type Stream = ReturnType<typeof useAnalysisStream>;

interface Params {
  stream: Stream;
  effectiveStockId: string | null;
  analysisId: string | null;
  symbol: string | null;
  market: string;
  name: string;
  router: { replace: (href: string) => void };
  formSettingId: string;
  formModel: string;
}

export function useStockAnalysisLifecycle(params: Params) {
  const [state, dispatch] = useReducer(lifecycleReducer, INITIAL_LIFECYCLE_STATE);
  const ref = useRef(params);
  ref.current = params;
  const currentRef = useRef<AnalysisHistoryItemDto | null>(null);
  currentRef.current = state.current;

  const { effectiveStockId, analysisId } = params;

  useEffect(() => {
    if (!analysisId) return;
    const { stream } = ref.current;
    if (stream.analysisId && stream.analysisId !== analysisId) {
      stream.reset();
      dispatch({ t: 'current', analysis: null });
    } else if (stream.status !== 'idle' && stream.analysisId === analysisId) {
      return;
    }
    let cancelled = false;
    dispatch({ t: 'checking', v: true });
    getAnalysis(analysisId)
      .then((analysis) => {
        if (cancelled) return;
        dispatch({ t: 'current', analysis });
        ref.current.stream.startStream(analysisId);
      })
      .catch(() => {
        if (!cancelled) ref.current.stream.startStream(analysisId);
      })
      .finally(() => {
        if (!cancelled) dispatch({ t: 'checking', v: false });
      });
    return () => { cancelled = true; };
    // URL analysisId is the only loader dependency by design.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [analysisId]);

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
        dispatch({ t: 'recent', items: res.items });
        if (!analysisId) {
          const target = findOngoingAnalysis(res.items) ?? res.items[0];
          if (target) {
            dispatch({ t: 'current', analysis: target });
            ref.current.stream.startStream(target.id);
          }
        }
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled && !analysisId) dispatch({ t: 'checking', v: false });
      });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveStockId, analysisId]);

  const streamStatus = params.stream.status;
  const streamAnalysisId = params.stream.analysisId;
  useEffect(() => {
    if (!['completed', 'error', 'cancelled'].includes(streamStatus)) return;
    if (!streamAnalysisId) return;
    const current = currentRef.current;
    if (current?.id === streamAnalysisId && !['PENDING', 'IN_PROGRESS'].includes(current.status)) return;
    let cancelled = false;
    getAnalysis(streamAnalysisId)
      .then((analysis) => { if (!cancelled) dispatch({ t: 'current', analysis }); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [streamStatus, streamAnalysisId]);

  const tryCreate = async (payload: CreatePayload, afterSuccess: (analysis: AnalysisDto) => void) => {
    const currentParams = ref.current;
    if (!currentParams.effectiveStockId) {
      toast.error('缺少股票记录，请先添加到自选股后再开始研究。');
      return false;
    }
    dispatch({ t: 'loading', v: true });
    try {
      const analysis = await createAnalysis(
        currentParams.effectiveStockId,
        payload.mode,
        payload.focusWindow,
        payload.settingId,
        payload.model,
        payload.question,
      );
      dispatch({ t: 'loading', v: false });
      afterSuccess(analysis);
      return true;
    } catch (error) {
      dispatch({ t: 'loading', v: false });
      toast.error(error instanceof Error ? error.message : '创建研究失败');
      return false;
    }
  };

  const startAnalysis = async (payload: CreatePayload) =>
    tryCreate(payload, (analysis) => {
      const p = ref.current;
      dispatch({ t: 'current', analysis });
      p.stream.reset();
      p.stream.startStream(analysis.id);
      p.router.replace(buildStockAnalysisUrl({
        symbol: p.symbol,
        stockId: analysis.stockId,
        analysisId: analysis.id,
        market: p.market,
        name: p.name,
      }));
    });

  const rerun = async () => {
    const current = state.current;
    const p = ref.current;
    if (!current || !p.effectiveStockId) return;
    await tryCreate({
      mode: current.mode,
      focusWindow: current.focusWindow,
      settingId: p.formSettingId || undefined,
      model: p.formModel || undefined,
      question: current.question || undefined,
    }, (analysis) => {
      dispatch({ t: 'current', analysis });
      p.stream.reset();
      p.stream.startStream(analysis.id);
      p.router.replace(buildStockAnalysisUrl({
        symbol: p.symbol,
        stockId: analysis.stockId,
        analysisId: analysis.id,
        market: p.market,
        name: p.name,
      }));
    });
  };

  const retry = async () => {
    const analysisId = ref.current.stream.analysisId;
    if (!analysisId) return;
    try {
      await apiRetryAnalysis(analysisId);
      ref.current.stream.reset();
      ref.current.stream.startStream(analysisId);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '重试失败');
    }
  };

  return {
    recentAnalyses: state.recentAnalyses,
    currentAnalysisMeta: state.current,
    checkingOngoing: state.checkingOngoing,
    loading: state.loading,
    startAnalysis,
    rerun,
    retryAnalysis: retry,
  };
}
