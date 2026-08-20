'use client';

import Link from 'next/link';
import { ArrowUpRight } from 'lucide-react';
import type { HomepageWatchlistItemDto } from '@bourse/shared-types';
import { Sparkline } from '@/components/charts/primitives/sparkline';
import {
  type SparklineState,
  useWatchlistSparklines,
} from '@/components/charts/use-watchlist-sparklines';
import { Card, Pill, Sym, Table, TBody, THead } from '@/components/ui';
import {
  CONFIDENCE_LABELS,
  MARKET_LABELS,
  SIGNAL_LABELS,
} from '@/lib/constants';
import { signalPillVariant } from '@/lib/pills';
import { stockHref } from '@/lib/stock-href';

export function HomepageWatchlistTable({
  items,
}: {
  items: HomepageWatchlistItemDto[];
}) {
  const sparklines = useWatchlistSparklines(
    items.map((item) => ({
      symbol: item.stock.symbol,
      market: item.stock.market,
    })),
  );
  const marketAsOf = Object.values(sparklines)
    .flatMap((state) => (state.status === 'ready' ? [state.asOf] : []))
    .sort()
    .at(-1);

  if (items.length === 0) {
    return (
      <Card>
        <div className="px-6 py-12 text-center">
          <p className="m-0 text-[14px] font-medium">还没有自选股票</p>
          <p className="mt-1.5 mb-0 text-[13px] text-[var(--color-fg-2)]">
            使用上方搜索添加第一只股票。
          </p>
        </div>
      </Card>
    );
  }

  return (
    <Card>
      <div className="hidden overflow-x-auto xl:block">
        <Table className="min-w-[920px]">
          <THead>
            <tr>
              <th>股票</th>
              <th>最近收盘</th>
              <th>30 日走势</th>
              <th>最新信号</th>
              <th>置信度</th>
              <th>研究数据截至</th>
            </tr>
          </THead>
          <TBody>
            {items.map((item) => {
              const state = sparklines[historyKey(item)] ?? { status: 'loading' };
              const href = researchHref(item);
              return (
                <tr key={item.id}>
                  <td className="min-w-[190px]">
                    <Link href={href} className="group block min-w-0">
                      <span className="flex items-center gap-2">
                        <Sym>{item.stock.symbol}</Sym>
                        <span className="font-mono text-[10.5px] text-[var(--color-fg-3)]">
                          {MARKET_LABELS[item.stock.market] ?? item.stock.market}
                        </span>
                      </span>
                      <span className="mt-0.5 block max-w-[180px] truncate text-[12.5px] text-[var(--color-fg-2)] group-hover:text-[var(--color-fg)]">
                        {item.stock.name}
                      </span>
                    </Link>
                  </td>
                  <td className="w-[120px]">
                    <QuoteCell state={state} currency={item.stock.currency} />
                  </td>
                  <td className="w-[148px]">
                    <TrendCell state={state} />
                  </td>
                  <td className="w-[116px]">
                    <ResearchSignal item={item} />
                  </td>
                  <td className="w-[92px]">
                    <ResearchConfidence item={item} />
                  </td>
                  <td className="w-[140px]">
                    <ResearchDate item={item} />
                  </td>
                </tr>
              );
            })}
          </TBody>
        </Table>
      </div>

      <div className="divide-y divide-[var(--color-border-soft)] xl:hidden">
        {items.map((item) => {
          const state = sparklines[historyKey(item)] ?? { status: 'loading' };
          const href = researchHref(item);
          return (
            <article key={item.id} className="px-4 py-4">
              <div className="flex items-start justify-between gap-3">
                <Link href={href} className="min-w-0">
                  <span className="flex items-center gap-2">
                    <Sym>{item.stock.symbol}</Sym>
                    <span className="font-mono text-[10.5px] text-[var(--color-fg-3)]">
                      {MARKET_LABELS[item.stock.market] ?? item.stock.market}
                    </span>
                  </span>
                  <span className="mt-1 block truncate text-[13px] text-[var(--color-fg-2)]">
                    {item.stock.name}
                  </span>
                </Link>
                <div className="shrink-0 text-right">
                  <QuoteCell state={state} currency={item.stock.currency} />
                </div>
              </div>
              <div className="mt-4 flex min-h-[34px] items-end justify-between gap-3">
                <TrendCell state={state} compact />
                <div className="flex min-w-0 items-center gap-2">
                  <ResearchSignal item={item} />
                  <ResearchDate item={item} compact />
                  <OpenStockLink href={href} name={item.stock.name} />
                </div>
              </div>
            </article>
          );
        })}
      </div>

      <div className="flex flex-col gap-1 border-t border-[var(--color-border-soft)] px-4 py-3 font-mono text-[10.5px] text-[var(--color-fg-2)] sm:flex-row sm:items-center sm:justify-between">
        <span>
          {marketAsOf ? `行情截至 ${marketAsOf}` : '行情日期以最近可用交易日为准'} · 研究日期按证据快照口径
        </span>
        <span className="shrink-0">US · HK · CN</span>
      </div>
    </Card>
  );
}

function historyKey(item: HomepageWatchlistItemDto): string {
  return `${item.stock.market}:${item.stock.symbol}`;
}

function researchHref(item: HomepageWatchlistItemDto): string {
  return stockHref(
    item.stock,
    item.latestResearch
      ? { analysisId: item.latestResearch.analysisId }
      : undefined,
  );
}

function quoteFrom(state: SparklineState) {
  if (state.status !== 'ready' || state.closes.length < 2) return null;
  const latest = state.closes.at(-1)!;
  const previous = state.closes.at(-2)!;
  return {
    latest,
    changePct: previous === 0 ? null : ((latest - previous) / previous) * 100,
  };
}

function QuoteCell({
  state,
  currency,
}: {
  state: SparklineState;
  currency: string;
}) {
  if (state.status === 'loading') {
    return (
      <div className="space-y-1.5" aria-label="行情加载中">
        <span className="block h-3.5 w-16 animate-pulse rounded bg-[var(--color-surface-2)] motion-reduce:animate-none" />
        <span className="block h-2.5 w-10 animate-pulse rounded bg-[var(--color-surface-2)] motion-reduce:animate-none" />
      </div>
    );
  }
  const quote = quoteFrom(state);
  if (!quote) {
    return <span className="text-[12px] text-[var(--color-fg-2)]">行情不可用</span>;
  }
  const positive = quote.changePct !== null && quote.changePct > 0;
  const negative = quote.changePct !== null && quote.changePct < 0;
  return (
    <>
      <div className="font-mono text-[13px] font-medium tabular-nums">
        {formatPrice(quote.latest, currency)}
      </div>
      <div
        className={
          'mt-0.5 font-mono text-[11px] tabular-nums ' +
          (positive
            ? 'text-[var(--color-signal-bullish)]'
            : negative
              ? 'text-[var(--color-signal-bearish)]'
              : 'text-[var(--color-fg-2)]')
        }
      >
        {quote.changePct === null
          ? '—'
          : `${positive ? '+' : ''}${quote.changePct.toFixed(2)}%`}
      </div>
    </>
  );
}

function TrendCell({
  state,
  compact = false,
}: {
  state: SparklineState;
  compact?: boolean;
}) {
  const width = compact ? 104 : 120;
  if (state.status === 'loading') {
    return (
      <span
        className="block h-[28px] animate-pulse rounded bg-[var(--color-surface-2)] motion-reduce:animate-none"
        style={{ width }}
        aria-label="走势加载中"
      />
    );
  }
  if (state.status === 'empty') {
    return <span className="text-[12px] text-[var(--color-fg-2)]">暂无走势</span>;
  }
  return (
    <span className="block h-[28px] shrink-0" style={{ width }}>
      <Sparkline
        closes={state.closes}
        anomalyIndex={state.anomalyIndex ?? undefined}
        width={width}
        height={28}
      />
    </span>
  );
}

function ResearchSignal({ item }: { item: HomepageWatchlistItemDto }) {
  const signal = item.latestResearch?.signal;
  if (!item.latestResearch) return <Pill variant="neutral">未研究</Pill>;
  const variant = signalPillVariant(signal);
  if (!signal || !variant) return <Pill variant="neutral">信息不足</Pill>;
  return <Pill variant={variant}>{SIGNAL_LABELS[signal] ?? signal}</Pill>;
}

function ResearchConfidence({ item }: { item: HomepageWatchlistItemDto }) {
  const confidence = item.latestResearch?.confidence;
  if (!confidence) return <span className="text-[var(--color-fg-3)]">—</span>;
  const dotClass =
    confidence === 'HIGH'
      ? 'bg-[var(--color-accent)]'
      : confidence === 'MEDIUM'
        ? 'bg-[var(--color-warn)]'
        : 'bg-[var(--color-fg-3)]';
  return (
    <span className="inline-flex items-center gap-1.5 text-[12px] text-[var(--color-fg-2)]">
      <span className={`h-1.5 w-1.5 rounded-full ${dotClass}`} />
      {CONFIDENCE_LABELS[confidence] ?? confidence}
    </span>
  );
}

function ResearchDate({
  item,
  compact = false,
}: {
  item: HomepageWatchlistItemDto;
  compact?: boolean;
}) {
  const value = item.latestResearch?.dataAsOf;
  return (
    <span
      className={
        'font-mono text-[11px] text-[var(--color-fg-2)] ' +
        (compact ? 'max-w-[84px] truncate' : '')
      }
      title={value ?? undefined}
    >
      {value ?? '—'}
    </span>
  );
}

function OpenStockLink({ href, name }: { href: string; name: string }) {
  return (
    <Link
      href={href}
      aria-label={`打开 ${name}`}
      title={`打开 ${name}`}
      className="inline-grid h-7 w-7 shrink-0 place-items-center rounded-[var(--radius-btn)] border border-[var(--color-border)] text-[var(--color-fg-2)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-fg)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-fg)]"
    >
      <ArrowUpRight className="h-3.5 w-3.5" strokeWidth={1.5} />
    </Link>
  );
}

function formatPrice(value: number, currency: string): string {
  try {
    return new Intl.NumberFormat('zh-CN', {
      style: 'currency',
      currency,
      currencyDisplay: 'narrowSymbol',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(value);
  } catch {
    return `${value.toFixed(2)} ${currency}`;
  }
}
