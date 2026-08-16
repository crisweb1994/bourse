'use client';

/**
 * L1 股票页常驻价格图（product decision D3：~300px 首屏即见）。
 * 自包含取数：GET /stocks/:symbol/history（365d 固定图表窗口 D1），
 * 四态走 ChartFrame（V3/V5 唯一执行点）。
 * R-3（v2.2）：CN 源无复权数据时如实标注"未复权"。
 */

import { useEffect, useState } from 'react';
import { MessageSquareText } from 'lucide-react';
import { STOCK_HISTORY_DAYS_WHITELIST, type StockHistoryDays, type StockHistoryResponse } from '@bourse/shared-types';
import { getStockHistory } from '@/lib/api';
import { ChartFrame } from './chart-frame';
import { PriceChart } from './price-chart/price-chart';

export function StockPriceChart({
  symbol,
  market,
  onAsk,
}: {
  symbol: string;
  market: string;
  onAsk?: () => void;
}) {
  const [days, setDays] = useState<StockHistoryDays>(365);
  const [retryToken, setRetryToken] = useState(0);
  const [state, setState] = useState<
    | { status: 'loading' }
    | { status: 'ready'; data: StockHistoryResponse }
    | { status: 'empty'; message: string }
    | { status: 'error'; message: string }
  >({ status: 'loading' });

  useEffect(() => {
    let alive = true;
    setState({ status: 'loading' });
    getStockHistory(symbol, market, days)
      .then((data) => {
        if (!alive) return;
        if (!data.priceSeries?.bars?.length) {
          setState({ status: 'empty', message: '暂无行情历史数据' });
        } else {
          setState({ status: 'ready', data });
        }
      })
      .catch((err: unknown) => {
        if (!alive) return;
        setState({
          status: 'error',
          message: err instanceof Error ? err.message : '行情加载失败',
        });
      });
    return () => {
      alive = false;
    };
  }, [symbol, market, days, retryToken]);

  const data = state.status === 'ready' ? state.data : null;
  const ps = data?.priceSeries;
  // R-3：CN 免费源无复权（basis=raw），365 天窗口跨除权日需如实提示
  const basisNote =
    ps?.basis === 'mixed'
      ? '复权口径混合：部分 K 线使用复权收盘，跨除权日请谨慎比较'
      : ps?.basis === 'raw' && (market === 'CN' || market === 'HK')
      ? '数据未复权：跨除权日的涨跌跳空为真实历史事件，趋势线在除权日会出现台阶'
      : undefined;

  return (
    <ChartFrame
      title="价格走势与技术结构"
      status={
        state.status === 'ready' ? 'ready'
        : state.status === 'loading' ? 'loading'
        : 'empty'
      }
      asOf={ps?.asOf ?? null}
      sourceTier={ps?.sourceTier ?? null}
      actions={onAsk ? (
        <button
          type="button"
          onClick={onAsk}
          className="inline-flex items-center gap-1 text-[11px] text-[var(--color-accent)] hover:underline"
        >
          <MessageSquareText className="h-3 w-3" aria-hidden />
          询问此图
        </button>
      ) : null}
      emptyReason={
        state.status === 'empty' || state.status === 'error'
          ? { message: state.message }
          : undefined
      }
      onRetry={state.status === 'error' ? () => setRetryToken((value) => value + 1) : undefined}
      degradedNote={basisNote}
      ariaSummary={
        ps
          ? `近一年 ${ps.bars.length} 根K线，52周区间 ${ps.week52Low?.toFixed(1) ?? '—'} 至 ${ps.week52High?.toFixed(1) ?? '—'}`
          : '价格走势图加载中'
      }
    >
      {data ? (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-1" role="group" aria-label="行情区间">
            {STOCK_HISTORY_DAYS_WHITELIST.map((option) => (
              <button
                key={option}
                type="button"
                aria-pressed={days === option}
                onClick={() => setDays(option)}
                className={`rounded-[5px] border px-2 py-1 text-[10.5px] font-mono ${days === option ? 'border-[var(--color-accent)] bg-[var(--color-accent-soft)] text-[var(--color-accent)]' : 'border-[var(--color-border)] text-[var(--color-fg-3)] hover:border-[var(--color-accent)]'}`}
              >
                {option === 1095 ? '3Y' : option === 365 ? '1Y' : `${option}D`}
              </button>
            ))}
          </div>
          <PriceChart
            priceSeries={data.priceSeries}
            technical={data.technical as never}
            market={market}
            height={300}
          />
        </div>
      ) : null}
    </ChartFrame>
  );
}
