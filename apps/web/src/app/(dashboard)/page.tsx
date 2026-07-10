'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { Loader2, ChevronRight } from 'lucide-react';
import { StockSearch } from '@/components/stock/stock-search';
import { WatchlistTable } from '@/components/watchlist/watchlist-table';
import { useWatchlist } from '@/hooks/use-watchlist';
import { useAuth } from '@/hooks/use-auth';
import { getAnalysisHistory, type AnalysisHistoryItemDto } from '@/lib/api';
import {
  ANALYSIS_TYPE_LABELS,
  SIGNAL_LABELS_BILINGUAL,
  STATUS_LABELS,
} from '@/lib/constants';
import { stockHref } from '@/lib/stock-href';
import { statusPillVariant, signalPillVariant } from '@/lib/pills';
import {
  Card,
  CardHead,
  PageHeader,
  Pill,
  SectionHead,
  Sym,
} from '@/components/ui';

export default function DashboardPage() {
  const { user } = useAuth();
  const { items: watchlist, loading: loadingWatch, refresh } = useWatchlist();
  const [recent, setRecent] = useState<AnalysisHistoryItemDto[]>([]);
  const [loadingRecent, setLoadingRecent] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const data = await getAnalysisHistory(1, 5);
        setRecent(data.items);
      } catch {} finally {
        setLoadingRecent(false);
      }
    })();
  }, []);

  return (
    <>
      <PageHeader
        tag="首页"
        title={
          <>
            你好{user?.name ? <>，{user.name.split(' ')[0]}</> : ''}
          </>
        }
        subtitle="搜索一只股票开始分析，或从下方的自选股 / 最近分析继续。"
      />

      {/* 搜索股票 */}
      <section className="mb-12">
        <SectionHead
          title="分析一只股票"
          hint="搜索美股 · 港股 · A 股 · 日股 · 英股 — 按代码或公司名。"
        />
        <div className="max-w-[680px]">
          <StockSearch onAdded={refresh} />
        </div>
      </section>

      {/* 自选股 — 完整 WatchlistTable */}
      <section className="mb-12">
        <SectionHead
          title="自选股"
          hint={`共 ${watchlist.length} 只`}
          actions={
            <Link
              href="/watchlist"
              className="font-mono text-[11px] uppercase tracking-[0.08em] text-[var(--color-fg-2)] hover:text-[var(--color-fg)] transition-colors"
            >
              管理 →
            </Link>
          }
        />
        {loadingWatch ? (
          <Card>
            <div className="px-6 py-10 grid place-items-center">
              <Loader2
                className="w-4 h-4 animate-spin text-[var(--color-fg-3)]"
                strokeWidth={1.5}
              />
            </div>
          </Card>
        ) : (
          <WatchlistTable items={watchlist} onChanged={refresh} />
        )}
      </section>

      {/* 最近分析 */}
      <section>
        <SectionHead
          title="最近分析"
          hint="最近 5 条运行记录"
          actions={
            <Link
              href="/history"
              className="font-mono text-[11px] uppercase tracking-[0.08em] text-[var(--color-fg-2)] hover:text-[var(--color-fg)] transition-colors"
            >
              全部 →
            </Link>
          }
        />
        <Card>
          {loadingRecent ? (
            <div className="px-6 py-10 grid place-items-center">
              <Loader2
                className="w-4 h-4 animate-spin text-[var(--color-fg-3)]"
                strokeWidth={1.5}
              />
            </div>
          ) : recent.length === 0 ? (
            <div className="px-6 py-10 text-center text-[13px] text-[var(--color-fg-3)]">
              暂无分析记录，搜索一只股票开始。
            </div>
          ) : (
            <div>
              {recent.map((item) => {
                const sig = signalPillVariant(item.overallSignal);
                return (
                  <Link
                    key={item.id}
                    href={stockHref(item.stock, { analysisId: item.id })}
                    className="grid grid-cols-[90px_minmax(0,1fr)_auto_auto_auto_auto] gap-4 items-center px-[18px] py-3 border-b border-[var(--color-border-soft)] last:border-b-0 transition-colors hover:bg-[var(--color-surface-hover)]"
                  >
                    <span className="font-mono text-[11.5px] text-[var(--color-fg-3)] tracking-[0.04em]">
                      {new Date(item.createdAt).toLocaleDateString('zh-CN', {
                        month: 'short',
                        day: 'numeric',
                      })}
                    </span>
                    <span className="text-[13.5px] truncate min-w-0">
                      <Sym>{item.symbol}</Sym>
                      <span className="text-[var(--color-fg-3)] mx-1.5">·</span>
                      <span className="text-[var(--color-fg-2)]">
                        {item.stock.name}
                      </span>
                    </span>
                    <Pill variant="flat">
                      <span className="font-mono">
                        {ANALYSIS_TYPE_LABELS[item.analysisType] ||
                          item.analysisType}
                      </span>
                    </Pill>
                    <Pill variant={statusPillVariant(item.status)} dot>
                      {STATUS_LABELS[item.status] || item.status}
                    </Pill>
                    {sig ? (
                      <Pill variant={sig}>
                        {SIGNAL_LABELS_BILINGUAL[item.overallSignal!] ||
                          item.overallSignal}
                      </Pill>
                    ) : (
                      <span className="font-mono text-[11.5px] text-[var(--color-fg-3)]">
                        —
                      </span>
                    )}
                    <ChevronRight
                      className="w-3.5 h-3.5 text-[var(--color-fg-3)]"
                      strokeWidth={1.5}
                    />
                  </Link>
                );
              })}
            </div>
          )}
        </Card>
      </section>
    </>
  );
}
