'use client';

/**
 * C13 · watchlist 行内 30 日 sparkline（visualization PRD §5.2）。
 * 一次批量请求获取 30 日收盘，
 * 失败静默（该格留空 —— V5：无数据不画，不报错刷屏）。
 */

import { useEffect, useRef, useState } from 'react';
import { getStockHistoryBatch } from '@/lib/api';

export type SparklineState =
  | { status: 'loading' }
  | { status: 'ready'; closes: number[]; anomalyIndex: number | null }
  | { status: 'empty' };

const cache = new Map<string, { closes: number[]; anomalyIndex: number | null }>();

export function useWatchlistSparklines(
  items: Array<{ symbol: string; market: string }>,
): Record<string, SparklineState> {
  const [states, setStates] = useState<Record<string, SparklineState>>({});
  const generation = useRef(0);

  // 调用方（watchlist-table）每次 render 都新建 items 数组 —— 以内容派生的
  // 稳定字符串键作为 effect 依赖，否则 setStates 每轮触发重渲染死循环
  // （Maximum update depth exceeded）。
  const itemsKey = items.map((item) => `${item.market}:${item.symbol}`).join('|');

  useEffect(() => {
    const gen = ++generation.current;
    const unique = new Map<string, { symbol: string; market: string }>();
    for (const item of items) unique.set(`${item.market}:${item.symbol}`, item);
    const entries = [...unique.values()].filter(
      (item) => !cache.has(`${item.market}:${item.symbol}`),
    );

    const initial: Record<string, SparklineState> = {};
    for (const item of items) {
      const key = `${item.market}:${item.symbol}`;
      const hit = cache.get(key);
      initial[key] = hit
        ? { status: 'ready', closes: hit.closes, anomalyIndex: hit.anomalyIndex }
        : { status: 'loading' };
    }
    setStates(initial);
    if (entries.length === 0) return;

    void (async () => {
      const batches: Awaited<ReturnType<typeof getStockHistoryBatch>>[] = [];
      // The API intentionally caps one request at 50 instruments. Chunk here
      // so a larger watchlist degrades per chunk instead of losing every row.
      for (let offset = 0; offset < entries.length; offset += 50) {
        try {
          batches.push(await getStockHistoryBatch(entries.slice(offset, offset + 50), 30));
        } catch {
          // Preserve empty cells for this chunk and continue with the rest.
        }
        if (gen !== generation.current) return;
      }
      const batch = {
        items: batches.flatMap((item) => item.items),
      };
      if (gen !== generation.current) return;
      setStates((prev) => {
        const next = { ...prev };
        const returned = new Map(batch.items.map((item) => [item.key, item.response]));
        entries.forEach((item) => {
          const key = `${item.market}:${item.symbol}`;
          const response = returned.get(key);
          const closes = (response?.priceSeries?.bars ?? []).map((bar) => bar.c);
          if (closes.length >= 3) {
            const anomalyIndex = response?.anomalyIndex ?? null;
            cache.set(key, { closes, anomalyIndex });
            next[key] = { status: 'ready', closes, anomalyIndex };
          } else {
            next[key] = { status: 'empty' };
          }
        });
        return next;
      });
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemsKey]);

  return states;
}
