'use client';

/**
 * C13 · watchlist 行内 30 日 sparkline（visualization PRD §5.2）。
 * 每行一次 getStockHistory(symbol, market, 30)，并发受限（4），
 * 失败静默（该格留空 —— V5：无数据不画，不报错刷屏）。
 */

import { useEffect, useRef, useState } from 'react';
import { getStockHistory } from '@/lib/api';

export type SparklineState =
  | { status: 'loading' }
  | { status: 'ready'; closes: number[] }
  | { status: 'empty' };

const cache = new Map<string, number[]>();

async function fetchCloses(
  symbol: string,
  market: string,
  signal: AbortSignal,
): Promise<number[]> {
  const key = `${market}:${symbol}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const res = await getStockHistory(symbol, market, 30);
  const closes = (res.priceSeries?.bars ?? []).map((b) => b.c);
  if (closes.length >= 3) cache.set(key, closes);
  return closes;
}

/** Simple bounded-concurrency pool so 20 watchlist rows don't stampede. */
async function runPool<T>(
  jobs: Array<() => Promise<T>>,
  limit: number,
): Promise<Array<T | null>> {
  const results: Array<T | null> = new Array(jobs.length).fill(null);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, jobs.length) }, async () => {
    while (next < jobs.length) {
      const i = next++;
      try {
        results[i] = await jobs[i]!();
      } catch {
        results[i] = null;
      }
    }
  });
  await Promise.all(workers);
  return results;
}

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
      initial[key] = hit ? { status: 'ready', closes: hit } : { status: 'loading' };
    }
    setStates(initial);
    if (entries.length === 0) return;

    runPool(
      entries.map(
        (item) => () =>
          fetchCloses(item.symbol, item.market, new AbortController().signal),
      ),
      4,
    ).then((results) => {
      if (gen !== generation.current) return;
      setStates((prev) => {
        const next = { ...prev };
        results.forEach((closes, i) => {
          const item = entries[i]!;
          const key = `${item.market}:${item.symbol}`;
          next[key] = closes && closes.length >= 3 ? { status: 'ready', closes } : { status: 'empty' };
        });
        return next;
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemsKey]);

  return states;
}
