'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  ArrowUpRight,
  ChevronRight,
  FileText,
  NotebookTabs,
  Plus,
  RefreshCw,
} from 'lucide-react';
import type {
  HomepageBriefDto,
  HomepageChangeDto,
  HomepageRecentAnalysisDto,
} from '@bourse/shared-types';
import { HomepageWatchlistTable } from '@/components/homepage/homepage-watchlist-table';
import { StockSearch } from '@/components/stock/stock-search';
import { Button, Card, CardHead, Pill, SectionHead, Sym } from '@/components/ui';
import {
  FOCUS_WINDOW_LABELS,
  MODE_LABELS,
  STATUS_LABELS,
} from '@/lib/constants';
import { getHomepageBrief } from '@/lib/api';
import { statusPillVariant } from '@/lib/pills';
import { stockHref } from '@/lib/stock-href';

const SEARCH_INPUT_ID = 'homepage-stock-search';

export default function DashboardPage() {
  const [brief, setBrief] = useState<HomepageBriefDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadBrief = useCallback(async () => {
    setError(null);
    try {
      setBrief(await getHomepageBrief());
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '首页数据读取失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadBrief();
    window.addEventListener('watchlist:changed', loadBrief);
    return () => window.removeEventListener('watchlist:changed', loadBrief);
  }, [loadBrief]);

  const focusSearch = () => {
    document.getElementById(SEARCH_INPUT_ID)?.focus();
  };

  return (
    <>
      <header className="mb-10 flex flex-col gap-6 xl:flex-row xl:items-end xl:justify-between">
        <div>
          <h1 className="m-0 text-[28px] font-semibold leading-[1.2] tracking-[-0.015em]">
            研究总览
          </h1>
          <p className="mt-2 mb-0 text-[13px] text-[var(--color-fg-2)]">
            {formatToday()} · 关注变化与最近研究
          </p>
        </div>
        <div className="flex w-full flex-col gap-2 sm:flex-row xl:w-auto">
          <StockSearch
            inputId={SEARCH_INPUT_ID}
            autoFocus={false}
            placeholder="搜索代码或公司名"
            className="w-full sm:w-[360px]"
          />
          <Button
            type="button"
            variant="primary"
            className="h-10 shrink-0"
            onClick={focusSearch}
          >
            <Plus className="h-4 w-4" strokeWidth={1.5} />
            新建分析
          </Button>
        </div>
      </header>

      {loading && !brief ? (
        <HomepageSkeleton />
      ) : error && !brief ? (
        <HomepageError
          message={error}
          onRetry={() => {
            setLoading(true);
            void loadBrief();
          }}
        />
      ) : brief ? (
        <>
          <section className="mb-10" aria-labelledby="homepage-watchlist-title">
            <SectionHead
              title={<span id="homepage-watchlist-title">自选研究</span>}
              hint={`${brief.watchlist.length}${brief.hasMoreWatchlist ? '+' : ''} 只 · 首页最多显示 10 只`}
              actions={
                <Link
                  href="/watchlist"
                  className="inline-flex items-center gap-1 text-[12px] text-[var(--color-fg-2)] transition-colors hover:text-[var(--color-fg)]"
                >
                  管理自选
                  <ArrowUpRight className="h-3.5 w-3.5" strokeWidth={1.5} />
                </Link>
              }
            />
            <HomepageWatchlistTable items={brief.watchlist} />
          </section>

          <div className="grid gap-6 xl:grid-cols-2">
            <ChangesPanel items={brief.changes} />
            <RecentAnalysesPanel items={brief.recentAnalyses} />
          </div>
        </>
      ) : null}
    </>
  );
}

function ChangesPanel({ items }: { items: HomepageChangeDto[] }) {
  return (
    <section aria-labelledby="homepage-changes-title">
      <Card className="h-full">
        <CardHead hint="最多 5 条">
          <span id="homepage-changes-title">研究变化</span>
        </CardHead>
        {items.length === 0 ? (
          <EmptyPanel>当前自选没有晚于研究基线的新公告或财报卡。</EmptyPanel>
        ) : (
          <ol className="m-0 list-none p-0">
            {items.map((item) => {
              const earnings = item.kind === 'EARNINGS_CARD';
              const Icon = earnings ? NotebookTabs : FileText;
              return (
                <li
                  key={item.id}
                  className="border-b border-[var(--color-border-soft)] last:border-b-0"
                >
                  <Link
                    href={stockHref(item.stock)}
                    className="flex min-h-[92px] items-start gap-3 px-[18px] py-4 transition-colors hover:bg-[var(--color-surface-hover)] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--color-fg)]"
                  >
                    <span
                      className={
                        'mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-[6px] ' +
                        (earnings
                          ? 'bg-[var(--color-accent-soft)] text-[var(--color-accent-600)]'
                          : 'bg-[var(--color-surface-2)] text-[var(--color-fg-2)]')
                      }
                    >
                      <Icon className="h-4 w-4" strokeWidth={1.5} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2">
                        <Sym className="text-[12px]">{item.stock.symbol}</Sym>
                        <span className="font-mono text-[10.5px] text-[var(--color-fg-2)]">
                          {earnings ? '财报卡' : '公告'}
                        </span>
                      </span>
                      <span className="mt-1 block truncate text-[13.5px] font-medium">
                        {item.title}
                      </span>
                      <span className="mt-1 block truncate text-[12px] text-[var(--color-fg-2)]">
                        {item.detail}
                      </span>
                    </span>
                    <time
                      dateTime={item.occurredAt}
                      className="hidden shrink-0 font-mono text-[10.5px] text-[var(--color-fg-2)] sm:block"
                    >
                      {formatCompactDateTime(item.occurredAt)}
                    </time>
                    <ArrowUpRight
                      className="mt-1 h-3.5 w-3.5 shrink-0 text-[var(--color-fg-3)]"
                      strokeWidth={1.5}
                    />
                  </Link>
                </li>
              );
            })}
          </ol>
        )}
      </Card>
    </section>
  );
}

function RecentAnalysesPanel({ items }: { items: HomepageRecentAnalysisDto[] }) {
  return (
    <section aria-labelledby="homepage-recent-title">
      <Card className="h-full">
        <CardHead
          hint={
            <Link
              href="/history"
              className="inline-flex items-center gap-0.5 text-[var(--color-fg-2)] transition-colors hover:text-[var(--color-fg)]"
            >
              历史记录
              <ChevronRight className="h-3.5 w-3.5" strokeWidth={1.5} />
            </Link>
          }
        >
          <span id="homepage-recent-title">最近分析</span>
        </CardHead>
        {items.length === 0 ? (
          <EmptyPanel>暂无分析记录。搜索一只股票开始研究。</EmptyPanel>
        ) : (
          <ol className="m-0 list-none p-0">
            {items.map((item) => (
              <li
                key={item.id}
                className="border-b border-[var(--color-border-soft)] last:border-b-0"
              >
                <Link
                  href={stockHref(item.stock, { analysisId: item.id })}
                  className="flex min-h-[92px] items-center gap-3 px-[18px] py-4 transition-colors hover:bg-[var(--color-surface-hover)] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--color-fg)]"
                >
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline gap-2">
                      <Sym>{item.stock.symbol}</Sym>
                      <span className="truncate text-[12.5px] text-[var(--color-fg-2)]">
                        {item.stock.name}
                      </span>
                    </span>
                    <span className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[10.5px] text-[var(--color-fg-2)]">
                      <span>
                        {MODE_LABELS[item.mode]} · {FOCUS_WINDOW_LABELS[item.focusWindow]}
                      </span>
                      <time dateTime={item.createdAt}>
                        {formatCompactDateTime(item.createdAt)}
                      </time>
                    </span>
                  </span>
                  <Pill variant={statusPillVariant(item.status)} dot>
                    {STATUS_LABELS[item.status] ?? item.status}
                  </Pill>
                  <ChevronRight
                    className="h-3.5 w-3.5 shrink-0 text-[var(--color-fg-3)]"
                    strokeWidth={1.5}
                  />
                </Link>
              </li>
            ))}
          </ol>
        )}
      </Card>
    </section>
  );
}

function HomepageSkeleton() {
  return (
    <div aria-label="首页数据加载中" aria-busy="true">
      <section className="mb-10">
        <div className="mb-4 h-12 w-48 animate-pulse rounded bg-[var(--color-surface-2)] motion-reduce:animate-none" />
        <Card>
          {Array.from({ length: 5 }, (_, index) => (
            <div
              key={index}
              className="flex h-[68px] items-center gap-6 border-b border-[var(--color-border-soft)] px-5 last:border-b-0"
            >
              <span className="h-4 w-28 animate-pulse rounded bg-[var(--color-surface-2)] motion-reduce:animate-none" />
              <span className="h-4 w-20 animate-pulse rounded bg-[var(--color-surface-2)] motion-reduce:animate-none" />
              <span className="ml-auto h-7 w-28 animate-pulse rounded bg-[var(--color-surface-2)] motion-reduce:animate-none" />
            </div>
          ))}
        </Card>
      </section>
      <div className="grid gap-6 xl:grid-cols-2">
        {[0, 1].map((panel) => (
          <Card key={panel}>
            <div className="h-14 border-b border-[var(--color-border-soft)] px-5 py-5">
              <span className="block h-4 w-24 animate-pulse rounded bg-[var(--color-surface-2)] motion-reduce:animate-none" />
            </div>
            <div className="h-48 animate-pulse bg-[var(--color-bg-elev)] motion-reduce:animate-none" />
          </Card>
        ))}
      </div>
    </div>
  );
}

function HomepageError({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <Card>
      <div className="flex flex-col items-start gap-4 px-6 py-10 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="m-0 text-[14px] font-medium">首页数据暂时无法读取</p>
          <p className="mt-1.5 mb-0 text-[12.5px] text-[var(--color-fg-2)]">{message}</p>
        </div>
        <Button type="button" onClick={onRetry}>
          <RefreshCw className="h-3.5 w-3.5" strokeWidth={1.5} />
          重新加载
        </Button>
      </div>
    </Card>
  );
}

function EmptyPanel({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid min-h-[220px] place-items-center px-6 py-12 text-center text-[13px] text-[var(--color-fg-2)]">
      {children}
    </div>
  );
}

function formatToday(): string {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'long',
  }).format(new Date());
}

function formatCompactDateTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(value));
}
