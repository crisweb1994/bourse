'use client';

import { useEffect, useState } from 'react';
import { getStockNews, type StockNewsItem } from '@/lib/api';

interface UseStockNewsInput {
  symbol: string | null;
  market: string;
  stockId: string | null;
  /** Only fetch once the stock resolves so unknown symbols don't hit the endpoint. */
  enabled: boolean;
  limit?: number;
}

interface StockNewsState {
  items: StockNewsItem[];
  loading: boolean;
  degraded: boolean;
}

const IDLE: StockNewsState = { items: [], loading: false, degraded: false };

/**
 * Async announcements feed for the stock header. Deliberately decoupled from
 * the quote/profile detail fetch — news (filings + web-search) can take
 * seconds and must never block the price strip from rendering on first paint.
 * Keyed by (symbol, market) so URL stockId churn doesn't refetch.
 */
export function useStockNews({
  symbol,
  market,
  stockId,
  enabled,
  limit,
}: UseStockNewsInput): StockNewsState {
  const [state, setState] = useState<StockNewsState>(IDLE);

  useEffect(() => {
    if (!enabled || !symbol || !market || !stockId) {
      setState(IDLE);
      return;
    }
    let cancelled = false;
    setState({ items: [], loading: true, degraded: false });
    getStockNews(symbol, market, limit)
      .then((res) => {
        if (cancelled) return;
        setState({
          items: res.items,
          loading: false,
          degraded: Boolean(res.degraded),
        });
      })
      .catch(() => {
        if (cancelled) return;
        setState({ items: [], loading: false, degraded: true });
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol, market, stockId, enabled]);

  return state;
}
