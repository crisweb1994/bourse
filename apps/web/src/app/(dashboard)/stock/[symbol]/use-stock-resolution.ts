'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  addToWatchlist,
  getStockDetail,
  getWatchlist,
  type StockDetailResult,
} from '@/lib/api';
import { toast } from '@/components/ui';

interface UseStockResolutionInput {
  symbol: string | null;
  market: string;
  name: string;
  stockId: string | null;
}

export function useStockResolution({
  symbol,
  market,
  name,
  stockId,
}: UseStockResolutionInput) {
  const [detail, setDetail] = useState<StockDetailResult | null>(null);
  const [resolvingStock, setResolvingStock] = useState(false);
  const [watchlistItemId, setWatchlistItemId] = useState<string | null>(null);
  const [watchlistBusy, setWatchlistBusy] = useState(false);

  // Single stock-detail request drives both stockId resolution and the header's
  // quote/profile panel. Keyed by (symbol, market); stockId URL churn should
  // not re-fetch identical detail.
  useEffect(() => {
    if (!symbol || !market) {
      setDetail(null);
      setResolvingStock(false);
      return;
    }
    let cancelled = false;
    if (!stockId) setResolvingStock(true);
    getStockDetail(symbol, market)
      .then((r) => {
        if (!cancelled) setDetail(r);
      })
      .catch(() => {
        if (!cancelled) {
          setDetail({
            stock: null,
            quote: null,
            profile: null,
            candidates: [],
          });
        }
      })
      .finally(() => {
        if (!cancelled) setResolvingStock(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol, market]);

  const effectiveStockId = stockId ?? detail?.stock?.id ?? null;

  useEffect(() => {
    if (!effectiveStockId) {
      setWatchlistItemId(null);
      return;
    }
    let cancelled = false;
    getWatchlist()
      .then((items) => {
        if (cancelled) return;
        const match = items.find((i) => i.stockId === effectiveStockId);
        setWatchlistItemId(match?.id ?? null);
      })
      .catch(() => {
        if (!cancelled) setWatchlistItemId(null);
      });
    return () => {
      cancelled = true;
    };
  }, [effectiveStockId]);

  const canAddToWatchlist = useMemo(
    () =>
      !watchlistItemId &&
      !!(effectiveStockId || detail?.candidates?.length),
    [detail?.candidates?.length, effectiveStockId, watchlistItemId],
  );

  const handleAddToWatchlist = async () => {
    if (watchlistItemId || watchlistBusy) return;
    const candidate = detail?.candidates?.[0];
    const seed = candidate ?? (symbol
      ? {
          symbol,
          name: name || symbol,
          market,
          exchange: detail?.stock?.exchange ?? '',
          currency: detail?.stock?.currency ?? 'USD',
          yahooSymbol: detail?.stock?.yahooSymbol ?? undefined,
        }
      : null);
    if (!seed || !seed.symbol || !seed.market) {
      toast.error('股票信息不完整，无法加入自选');
      return;
    }

    setWatchlistBusy(true);
    try {
      const item = await addToWatchlist(seed);
      setWatchlistItemId(item.id);
      if (!stockId && !detail?.stock) {
        setDetail((prev) => ({
          stock: {
            id: item.stockId,
            symbol: item.stock.symbol,
            name: item.stock.name,
            market: item.stock.market,
            exchange: item.stock.exchange,
            currency: item.stock.currency,
            yahooSymbol: item.stock.yahooSymbol,
          },
          quote: prev?.quote ?? null,
          profile: prev?.profile ?? null,
          candidates: [],
        }));
      }
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : '加入自选失败');
    } finally {
      setWatchlistBusy(false);
    }
  };

  return {
    detail,
    resolvingStock,
    effectiveStockId,
    watchlistItemId,
    watchlistBusy,
    canAddToWatchlist,
    handleAddToWatchlist,
  };
}
