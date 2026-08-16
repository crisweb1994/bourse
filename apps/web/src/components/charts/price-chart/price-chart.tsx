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

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  CandlestickSeries,
  createSeriesMarkers,
  HistogramSeries,
  LineSeries,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type MouseEventParams,
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

export interface CorporateActionForChart {
  id?: string;
  type?: string;
  exDate?: string;
  announcedAt?: string;
  effectiveDate?: string;
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
  corporateActions = [],
}: {
  priceSeries: ChartPriceSeries;
  technical?: TechnicalForChart | null;
  market: string;
  height?: number;
  /** V4 出口：点击支撑/阻力标注 → 跳转模块论述（宿主决定去向）。 */
  onAnnotationClick?: (kind?: 'support' | 'resistance') => void;
  corporateActions?: CorporateActionForChart[];
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const [tooltip, setTooltip] = useState<{
    x: number;
    y: number;
    date: string;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number | null;
  } | null>(null);
  const corporateActionKey = corporateActions
    .map((action) => `${action.id ?? ''}:${action.exDate ?? action.effectiveDate ?? action.announcedAt ?? ''}:${action.type ?? ''}`)
    .join('|');

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

    // A tiny history cannot support a meaningful candle chart. The SVG
    // fallback below still exposes the observed closes without implying a
    // technical structure that the data cannot support.
    if (priceSeries.bars.length < 20) {
      chartRef.current = null;
      setTooltip(null);
      return;
    }

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

    const candleDates = new Set(priceSeries.bars.map((bar) => bar.t));
    const markers = corporateActions.flatMap((action, index) => {
      const date = (action.exDate ?? action.effectiveDate ?? action.announcedAt)?.slice(0, 10);
      if (!date || !candleDates.has(date)) return [];
      return [{
        id: action.id ?? `${date}-${index}`,
        time: toTime(date),
        position: 'aboveBar' as const,
        shape: 'circle' as const,
        color: '#e6a23c',
        text: action.type === 'DIVIDEND' ? '息' : action.type === 'SPLIT' ? '拆' : '权',
      }];
    });
    const markerPlugin = markers.length > 0 ? createSeriesMarkers(candle, markers) : null;

    const onCrosshairMove = (param: MouseEventParams<Time>) => {
      const point = param.point;
      const data = param.seriesData.get(candle) as
        | { time?: Time; open?: number; high?: number; low?: number; close?: number }
        | undefined;
      if (!point || !data || !Number.isFinite(data.close)) {
        setTooltip(null);
        return;
      }
      const date = typeof param.time === 'number'
        ? new Date(param.time * 1000).toISOString().slice(0, 10)
        : String(param.time ?? '');
      const bar = priceSeries.bars.find((item) => item.t === date);
      setTooltip({
        x: point.x,
        y: point.y,
        date,
        open: data.open ?? bar?.o ?? 0,
        high: data.high ?? bar?.h ?? 0,
        low: data.low ?? bar?.l ?? 0,
        close: data.close ?? bar?.c ?? 0,
        volume: bar?.v ?? null,
      });
    };
    chart.subscribeCrosshairMove(onCrosshairMove);

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
    applyPrintMode();
    observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });

    return () => {
      observer.disconnect();
      chart.unsubscribeCrosshairMove(onCrosshairMove);
      markerPlugin?.detach();
      setTooltip(null);
      for (const line of priceLines) {
        try { candle.removePriceLine(line); } catch { /* chart already disposed */ }
      }
      chart.remove();
      chartRef.current = null;
    };
  }, [priceSeries, technical, upColor, downColor, height, corporateActionKey]);

  // 主题切换重映射（next-themes class 翻转时）。观察 class 变化即可，
  // 不需要让每个图表长期运行定时器。
  useEffect(() => {
    const applyTheme = () => {
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
    };
    const observer = new MutationObserver(applyTheme);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style'] });
    return () => observer.disconnect();
  }, []);

  const levels = [
    technical?.nearestSupport != null ? { kind: 'support' as const, label: `支撑 ${technical.nearestSupport.toFixed(2)}` } : null,
    technical?.nearestResistance != null ? { kind: 'resistance' as const, label: `阻力 ${technical.nearestResistance.toFixed(2)}` } : null,
  ].filter((level): level is { kind: 'support' | 'resistance'; label: string } => level !== null);

  if (priceSeries.bars.length < 20) {
    const closes = priceSeries.bars.map((bar) => bar.c);
    const min = Math.min(...closes);
    const max = Math.max(...closes);
    const span = max - min || 1;
    const width = 460;
    const chartHeight = Math.max(180, height - 48);
    const pointX = (index: number) => 8 + (index * (width - 16)) / Math.max(closes.length - 1, 1);
    const pointY = (value: number) => 12 + ((max - value) / span) * (chartHeight - 28);
    return (
      <div className="space-y-2">
        <div className="relative" role="img" aria-label={`价格收盘散点图：${priceSeries.bars.length} 根，历史不足 20 根 K 线`}>
          <svg viewBox={`0 0 ${width} ${chartHeight}`} className="h-auto w-full">
            <path
              d={closes.map((value, index) => `${index === 0 ? 'M' : 'L'}${pointX(index).toFixed(1)},${pointY(value).toFixed(1)}`).join(' ')}
              fill="none"
              stroke="var(--color-accent)"
              strokeWidth={1.8}
            />
            {priceSeries.bars.map((bar, index) => (
              <circle key={bar.t} cx={pointX(index)} cy={pointY(bar.c)} r={3} fill="var(--color-accent)">
                <title>{`${bar.t}：收盘 ${bar.c.toFixed(2)}${bar.v == null ? '' : `，成交量 ${bar.v.toLocaleString()}`}`}</title>
              </circle>
            ))}
          </svg>
          <p className="m-0 text-[11px] text-[var(--color-fg-3)]">历史不足 20 根 K 线，仅显示收盘散点；不绘制均线。</p>
        </div>
        {levels.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {levels.map((level) => (
              <button
                key={level.kind}
                type="button"
                onClick={() => onAnnotationClick?.(level.kind)}
                className="rounded-[5px] border border-[var(--color-border)] px-2 py-1 text-[11px] text-[var(--color-fg-2)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
              >
                {level.label}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="relative" style={{ height }}>
        <div
          ref={containerRef}
          style={{ height }}
          className="w-full"
          role="img"
          aria-label={`价格走势图：${priceSeries.bars.length} 根K线，${priceSeries.basis === 'raw' ? '未复权' : priceSeries.basis === 'mixed' ? '复权口径混合' : '前复权'}${technical?.nearestSupport != null ? `，支撑 ${technical.nearestSupport.toFixed(2)}` : ''}${technical?.nearestResistance != null ? `，阻力 ${technical.nearestResistance.toFixed(2)}` : ''}`}
        />
        {tooltip ? (
          <div
            className="pointer-events-none absolute z-10 rounded-[5px] border border-[var(--color-border)] bg-[var(--color-bg-elev)] px-2 py-1.5 text-[10.5px] shadow-sm"
            style={{ left: Math.min(Math.max(tooltip.x + 10, 4), 250), top: Math.max(tooltip.y - 72, 4) }}
          >
            <div className="font-mono text-[var(--color-fg-2)]">{tooltip.date}</div>
            <div className="mt-0.5 grid grid-cols-2 gap-x-2 gap-y-0.5 font-mono text-[var(--color-fg-3)]">
              <span>开 {tooltip.open.toFixed(2)}</span><span>高 {tooltip.high.toFixed(2)}</span>
              <span>低 {tooltip.low.toFixed(2)}</span><span>收 {tooltip.close.toFixed(2)}</span>
              {tooltip.volume != null ? <span className="col-span-2">量 {tooltip.volume.toLocaleString()}</span> : null}
            </div>
          </div>
        ) : null}
      </div>
      {levels.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {levels.map((level) => (
            <button
              key={level.kind}
              type="button"
              onClick={() => onAnnotationClick?.(level.kind)}
              className="rounded-[5px] border border-[var(--color-border)] px-2 py-1 text-[11px] text-[var(--color-fg-2)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
            >
              {level.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
