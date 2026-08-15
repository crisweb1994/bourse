'use client';

/**
 * L1 股票页常驻价格图（product decision D3：~300px 首屏即见）。
 * 自包含取数：GET /stocks/:symbol/history（365d 固定图表窗口 D1），
 * 四态走 ChartFrame（V3/V5 唯一执行点）。
 * R-3（v2.2）：CN 源无复权数据时如实标注"未复权"。
 */

import { useEffect, useState } from 'react';
import type { StockHistoryResponse } from '@bourse/shared-types';
import { getStockHistory } from '@/lib/api';
import { ChartFrame } from './chart-frame';
import { PriceChart } from './price-chart/price-chart';

export function StockPriceChart({
  symbol,
  market,
}: {
  symbol: string;
  market: string;
}) {
  const [state, setState] = useState<
    | { status: 'loading' }
    | { status: 'ready'; data: StockHistoryResponse }
    | { status: 'empty'; message: string }
    | { status: 'error'; message: string }
  >({ status: 'loading' });

  useEffect(() => {
    let alive = true;
    setState({ status: 'loading' });
    getStockHistory(symbol, market, 365)
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
  }, [symbol, market]);

  const data = state.status === 'ready' ? state.data : null;
  const ps = data?.priceSeries;
  // R-3：CN 免费源无复权（basis=raw），365 天窗口跨除权日需如实提示
  const unadjustedNote =
    ps?.basis === 'raw' && (market === 'CN' || market === 'HK')
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
      emptyReason={
        state.status === 'empty' || state.status === 'error'
          ? { message: state.message }
          : undefined
      }
      degradedNote={unadjustedNote}
      ariaSummary={
        ps
          ? `近一年 ${ps.bars.length} 根K线，52周区间 ${ps.week52Low?.toFixed(1) ?? '—'} 至 ${ps.week52High?.toFixed(1) ?? '—'}`
          : '价格走势图加载中'
      }
    >
      {data ? (
        <PriceChart
          priceSeries={data.priceSeries}
          technical={data.technical as never}
          market={market}
          height={300}
        />
      ) : null}
    </ChartFrame>
  );
}
