'use client';

/**
 * C1 · 价格走势与技术结构图（visualization PRD §5.1，D3 常驻形态）。
 *
 * TradingView Lightweight Charts v5（`addSeries(CandlestickSeries)` API）。
 * - 数据全部来自服务端：priceSeries.bars + technical.series.sma*（{t,v} 点列，
 *   结构对齐 I5-I7）+ nearestSupport/Resistance 标注（P1：前端零计算）。
 * - 涨跌色按 market 切换：US 绿涨红跌 / CN·HK 红涨绿跌。
 * - 生命周期三件套（§六）：ResizeObserver / 主题重映射 / unmount remove()。
 * - V7：body.print-mode 时冻结当前视图高度，避免 canvas 打印空白。
 */

import { useEffect, useMemo, useRef } from 'react';
import {
  CandlestickSeries,
  HistogramSeries,
  LineSeries,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import type { ChartPriceSeries } from '@bourse/shared-types';

export interface TechnicalForChart {
  nearestSupport?: number | null;
  nearestResistance?: number | null;
  series?: {
    sma20?: Array<{ t: string; v: number }>;
    sma50?: Array<{ t: string; v: number }>;
    sma200?: Array<{ t: string; v: number }>;
  };
}

const SMA_STYLES = {
  sma20: { color: '#e8c35a', title: 'SMA20' },
  sma50: { color: '#b58cff', title: 'SMA50' },
  sma200: { color: '#5b8cff', title: 'SMA200' },
} as const;

function readThemeColors(): {
  text: string;
  grid: string;
  border: string;
} {
  if (typeof window === 'undefined') return { text: '#71809a', grid: '#1c2333', border: '#232a3a' };
  const cs = getComputedStyle(document.documentElement);
  const pick = (name: string, fallback: string): string => cs.getPropertyValue(name).trim() || fallback;
  return {
    text: pick('--color-fg-3', '#71809a'),
    grid: pick('--color-border-soft', '#1c2333'),
    border: pick('--color-border', '#232a3a'),
  };
}

export function PriceChart({
  priceSeries,
  technical,
  market,
  height = 300,
  onAnnotationClick,
}: {
  priceSeries: ChartPriceSeries;
  technical?: TechnicalForChart | null;
  market: string;
  height?: number;
  /** V4 出口：点击支撑/阻力标注 → 跳转模块论述（宿主决定去向）。 */
  onAnnotationClick?: () => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);

  // 涨跌语义色：US 绿涨红跌；CN/HK 红涨绿跌（真实产品惯例，D 决策）。
  const [upColor, downColor] = useMemo(
    () =>
      market === 'CN' || market === 'HK'
        ? ['#ef5b5b', '#3ecf8e']
        : ['#3ecf8e', '#ef5b5b'],
    [market],
  );

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const theme = readThemeColors();
    const chart = createChart(container, {
      height,
      autoSize: true,
      layout: {
        background: { color: 'transparent' },
        textColor: theme.text,
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: theme.grid },
        horzLines: { color: theme.grid },
      },
      rightPriceScale: { borderColor: theme.border },
      timeScale: { borderColor: theme.border, timeVisible: false },
      crosshair: { mode: 1 },
    });
    chartRef.current = chart;

    const candle = chart.addSeries(CandlestickSeries, {
      upColor,
      downColor,
      borderUpColor: upColor,
      borderDownColor: downColor,
      wickUpColor: upColor,
      wickDownColor: downColor,
    });
    const volume = chart.addSeries(HistogramSeries, {
      priceFormat: { type: 'volume' },
      priceScaleId: 'vol',
    });
    chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });

    const toTime = (t: string): Time =>
      (Math.floor(Date.parse(`${t}T00:00:00Z`) / 1000) as UTCTimestamp);

    candle.setData(
      priceSeries.bars.map((b) => ({
        time: toTime(b.t),
        open: b.o,
        high: b.h,
        low: b.l,
        close: b.c,
      })),
    );
    volume.setData(
      priceSeries.bars
        .filter((b) => b.v != null)
        .map((b) => ({
          time: toTime(b.t),
          value: b.v!,
          color: b.c >= b.o ? `${upColor}55` : `${downColor}55`,
        })),
    );

    for (const key of ['sma20', 'sma50', 'sma200'] as const) {
      const points = technical?.series?.[key];
      if (!points?.length) continue; // V5：窗口不足（如 sma200）不画，不补值
      const line = chart.addSeries(LineSeries, {
        color: SMA_STYLES[key].color,
        title: SMA_STYLES[key].title,
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: false,
      });
      line.setData(points.map((p) => ({ time: toTime(p.t), value: p.v })));
    }

    // 支撑/阻力标注（确定性计算值；可点击 → V4 出口）
    const levels: Array<{ value: number; color: string; title: string }> = [];
    if (technical?.nearestSupport != null) {
      levels.push({ value: technical.nearestSupport, color: '#3ecf8e', title: `支撑 ${technical.nearestSupport.toFixed(2)}` });
    }
    if (technical?.nearestResistance != null) {
      levels.push({ value: technical.nearestResistance, color: '#ef5b5b', title: `阻力 ${technical.nearestResistance.toFixed(2)}` });
    }
    const priceLines = levels.map((level) =>
      candle.createPriceLine({
        price: level.value,
        color: level.color,
        lineWidth: 1,
        lineStyle: 2, // dashed
        axisLabelVisible: true,
        title: level.title,
      }),
    );

    // 打印冻结（V7）：打印模式下固定视图，避免 canvas 空白
    const applyPrintMode = () => {
      const printing = document.body.classList.contains('print-mode');
      chart.applyOptions({ autoSize: !printing, height: printing ? height : undefined } as never);
    };
    const observer = new MutationObserver(applyPrintMode);
    observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });

    return () => {
      observer.disconnect();
      for (const line of priceLines) {
        try { candle.removePriceLine(line); } catch { /* chart already disposed */ }
      }
      chart.remove();
      chartRef.current = null;
    };
  }, [priceSeries, technical, upColor, downColor, height]);

  // 主题切换重映射（next-themes class 翻转时）
  useEffect(() => {
    const id = window.setInterval(() => {
      if (!chartRef.current) return;
      const theme = readThemeColors();
      chartRef.current.applyOptions({
        layout: { textColor: theme.text },
        grid: {
          vertLines: { color: theme.grid },
          horzLines: { color: theme.grid },
        },
        rightPriceScale: { borderColor: theme.border },
        timeScale: { borderColor: theme.border },
      });
    }, 2_000);
    return () => window.clearInterval(id);
  }, []);

  return (
    <div
      ref={containerRef}
      style={{ height }}
      className="w-full"
      role="img"
      aria-label={`价格走势图：${priceSeries.bars.length} 根K线，${priceSeries.basis === 'raw' ? '未复权' : priceSeries.basis === 'mixed' ? '复权口径混合' : '前复权'}${technical?.nearestSupport != null ? `，支撑 ${technical.nearestSupport.toFixed(2)}` : ''}${technical?.nearestResistance != null ? `，阻力 ${technical.nearestResistance.toFixed(2)}` : ''}`}
      onClick={onAnnotationClick}
    />
  );
}
