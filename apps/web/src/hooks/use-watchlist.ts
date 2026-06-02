'use client';

import { useState, useEffect, useCallback } from 'react';
import type { WatchlistItemDto } from '@bourse/shared-types';
import { getWatchlist } from '@/lib/api';

export function useWatchlist() {
  const [items, setItems] = useState<WatchlistItemDto[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const data = await getWatchlist();
      setItems(data);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    window.addEventListener('watchlist:changed', refresh);
    return () => window.removeEventListener('watchlist:changed', refresh);
  }, [refresh]);

  return { items, loading, refresh };
}
