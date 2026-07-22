'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  EarningsCardDto,
  EarningsGenerationRunDto,
  LatestEarningsResponseDto,
} from '@bourse/shared-types';
import {
  ApiError,
  createEarningsGeneration,
  getEarningsGeneration,
  getEarningsHistory,
  getLatestEarnings,
  retryEarningsGeneration,
} from '@/lib/api';

const POLL_MS = 1_500;

export function useEarningsCard({
  stockId,
  canGenerate,
}: {
  stockId: string | null;
  canGenerate: boolean;
}) {
  const [response, setResponse] = useState<LatestEarningsResponseDto | null>(null);
  const [generation, setGeneration] = useState<EarningsGenerationRunDto | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<EarningsCardDto[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const requestIdRef = useRef<string>('');
  const autoStartedForRef = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    if (!stockId) return null;
    setLoading(true);
    try {
      const latest = await getLatestEarnings(stockId);
      setResponse(latest);
      if (latest.generation) setGeneration(latest.generation);
      setError(null);
      return latest;
    } catch (cause) {
      setError(messageFor(cause));
      return null;
    } finally {
      setLoading(false);
    }
  }, [stockId]);

  const start = useCallback(async () => {
    if (!stockId || !canGenerate) return null;
    if (!requestIdRef.current) requestIdRef.current = crypto.randomUUID();
    setLoading(true);
    setError(null);
    try {
      const run = await createEarningsGeneration(stockId, requestIdRef.current);
      setGeneration(run);
      if (run.card) {
        setResponse({ available: true, supported: true, card: run.card });
      }
      return run;
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 409) {
        setResponse((current) => current ?? { available: false, supported: true, reason: 'NO_ELIGIBLE_FILING' });
      }
      setError(messageFor(cause));
      return null;
    } finally {
      setLoading(false);
    }
  }, [canGenerate, stockId]);

  const retry = useCallback(async () => {
    if (!generation) return;
    setLoading(true);
    setError(null);
    try {
      const run = await retryEarningsGeneration(generation.id);
      setGeneration(run);
    } catch (cause) {
      setError(messageFor(cause));
    } finally {
      setLoading(false);
    }
  }, [generation]);

  const loadHistory = useCallback(async () => {
    if (!stockId || historyLoading || history.length > 0) return;
    setHistoryLoading(true);
    try {
      setHistory(await getEarningsHistory(stockId));
    } catch {
      setError('财报版本历史暂时无法加载');
    } finally {
      setHistoryLoading(false);
    }
  }, [history.length, historyLoading, stockId]);

  useEffect(() => {
    setResponse(null);
    setGeneration(null);
    setError(null);
    setHistory([]);
    setHistoryLoading(false);
    requestIdRef.current = '';
    autoStartedForRef.current = null;
    if (!stockId) return;
    let cancelled = false;
    void refresh().then((latest) => {
      if (
        cancelled ||
        !latest ||
        latest.available ||
        !latest.supported ||
        latest.generation ||
        !canGenerate ||
        autoStartedForRef.current === stockId
      ) return;
      autoStartedForRef.current = stockId;
      void start();
    });
    return () => {
      cancelled = true;
    };
  }, [canGenerate, refresh, start, stockId]);

  useEffect(() => {
    if (!generation || !['QUEUED', 'RUNNING'].includes(generation.status)) return;
    let cancelled = false;
    const timer = window.setInterval(() => {
      void getEarningsGeneration(generation.id)
        .then((next) => {
          if (cancelled) return;
          setGeneration(next);
          if (next.card) {
            setResponse({ available: true, supported: true, card: next.card });
          }
        })
        .catch((cause) => {
          if (!cancelled) setError(messageFor(cause));
        });
    }, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [generation]);

  return {
    response,
    generation,
    loading,
    error,
    history,
    historyLoading,
    refresh,
    start,
    retry,
    loadHistory,
  };
}

function messageFor(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return '财报速读暂时不可用';
}
