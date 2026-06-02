'use client';

/**
 * plan-v2 Wave 4.1 — batch analysis backend removed. Watchlist page now
 * supports single-stock open / edit notes; batch panel + progress card
 * + per-row checkbox selection are gone.
 */
import { Loader2 } from 'lucide-react';
import { StockSearch } from '@/components/stock/stock-search';
import { WatchlistTable } from '@/components/watchlist/watchlist-table';
import { useWatchlist } from '@/hooks/use-watchlist';
import { Card, PageHeader, Pill, SectionHead } from '@/components/ui';

export default function WatchlistPage() {
  const { items, loading, refresh } = useWatchlist();

  return (
    <>
      <PageHeader
        tag="自选股"
        title="我的自选股"
        subtitle="跨市场跟踪股票。点击行可打开详情，悬停行可编辑备注。"
        actions={
          <Pill variant="flat">
            <span className="font-mono">共 {items.length} 只</span>
          </Pill>
        }
      />

      <section className="mb-10 max-w-[680px]">
        <StockSearch onAdded={refresh} />
      </section>

      <SectionHead
        title={<>共 {items.length} 只</>}
        hint="点击行可打开 · 悬停行可编辑备注"
      />

      {loading ? (
        <Card>
          <div className="px-6 py-10 grid place-items-center">
            <Loader2
              className="w-4 h-4 animate-spin text-[var(--color-fg-3)]"
              strokeWidth={1.5}
            />
          </div>
        </Card>
      ) : (
        <WatchlistTable items={items} onChanged={refresh} />
      )}
    </>
  );
}
