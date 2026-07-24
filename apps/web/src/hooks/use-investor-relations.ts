'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { InvestorRelationsGenerationRunDto, InvestorRelationsTimelineResponseDto } from '@bourse/shared-types';
import { ApiError, createInvestorRelationsGeneration, getInvestorRelationsGeneration, getInvestorRelationsTimeline, retryInvestorRelationsGeneration } from '@/lib/api';

const POLL_MS = 1_500;

export function useInvestorRelations({ stockId, canGenerate }: { stockId: string | null; canGenerate: boolean }) {
  const [response, setResponse] = useState<InvestorRelationsTimelineResponseDto | null>(null);
  const [generation, setGeneration] = useState<InvestorRelationsGenerationRunDto | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef('');
  const autoStarted = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    if (!stockId) return null;
    setLoading(true);
    try {
      const next = await getInvestorRelationsTimeline(stockId);
      setResponse(next);
      if (next.generation) setGeneration(next.generation);
      setError(null);
      return next;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '投关记录暂时无法加载');
      return null;
    } finally {
      setLoading(false);
    }
  }, [stockId]);

  const start = useCallback(async () => {
    if (!stockId || !canGenerate) return null;
    if (!requestId.current) requestId.current = crypto.randomUUID();
    setLoading(true);
    setError(null);
    try {
      const run = await createInvestorRelationsGeneration(stockId, requestId.current);
      setGeneration(run);
      return run;
    } catch (cause) {
      if (!(cause instanceof ApiError && cause.status === 409)) setError(cause instanceof Error ? cause.message : '投关记录生成失败');
      return null;
    } finally {
      setLoading(false);
    }
  }, [canGenerate, stockId]);

  const retry = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      if (!generation) {
        await start();
        return;
      }
      setGeneration(await retryInvestorRelationsGeneration(generation.id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '投关记录重试失败');
    } finally {
      setLoading(false);
    }
  }, [generation, start]);

  useEffect(() => {
    setResponse(null);
    setGeneration(null);
    setError(null);
    requestId.current = '';
    autoStarted.current = null;
    if (!stockId) return;
    let cancelled = false;
    void refresh().then((latest) => {
      if (cancelled || !latest?.supported || latest.events.length || latest.generation || !canGenerate || autoStarted.current === stockId) return;
      autoStarted.current = stockId;
      void start();
    });
    return () => { cancelled = true; };
  }, [canGenerate, refresh, start, stockId]);

  useEffect(() => {
    if (!generation || !['QUEUED', 'RUNNING'].includes(generation.status)) return;
    const timer = window.setInterval(() => {
      void getInvestorRelationsGeneration(generation.id).then((next) => {
        setGeneration(next);
        if (next.status === 'COMPLETED') void refresh();
      }).catch(() => undefined);
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [generation, refresh]);

  return { response, generation, loading, error, start, retry };
}
