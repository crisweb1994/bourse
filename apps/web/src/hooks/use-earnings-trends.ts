'use client';

import { useCallback, useEffect, useState } from 'react';
import type { EarningsTrendOptionDto, EarningsTrendSeriesDto } from '@bourse/shared-types';
import { ApiError, getEarningsTrend, getEarningsTrendOptions } from '@/lib/api';

export function useEarningsTrends(stockId: string | null) {
  const [options, setOptions] = useState<EarningsTrendOptionDto[]>([]);
  const [selected, setSelected] = useState<EarningsTrendOptionDto | null>(null);
  const [periods, setPeriods] = useState<4 | 8 | 12>(8);
  const [series, setSeries] = useState<EarningsTrendSeriesDto | null>(null);
  const [loading, setLoading] = useState(false);
  const [supported, setSupported] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setOptions([]);
    setSelected(null);
    setSeries(null);
    setSupported(true);
    setError(null);
    if (!stockId) return;
    let cancelled = false;
    void getEarningsTrendOptions(stockId).then((items) => {
      if (cancelled) return;
      setOptions(items);
      setSelected(items[0] ?? null);
    }).catch((error) => {
      if (!cancelled && error instanceof ApiError && error.status === 404) setSupported(false);
      else if (!cancelled) setError(error instanceof Error ? error.message : '趋势数据加载失败');
    });
    return () => { cancelled = true; };
  }, [stockId]);

  const loadSeries = useCallback(async () => {
    if (!stockId || !selected) return;
    setLoading(true);
    setError(null);
    try {
      setSeries(await getEarningsTrend(stockId, selected.metricCode, periods, selected.fingerprint));
    } catch (cause) {
      setSeries(null);
      setError(cause instanceof Error ? cause.message : '趋势数据加载失败');
    } finally {
      setLoading(false);
    }
  }, [periods, selected, stockId]);

  useEffect(() => { void loadSeries(); }, [loadSeries]);

  return { options, selected, setSelected, periods, setPeriods, series, loading, supported, error, reload: loadSeries };
}
