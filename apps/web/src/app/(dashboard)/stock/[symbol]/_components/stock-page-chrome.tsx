'use client';

import { ChevronLeft, Loader2 } from 'lucide-react';
import type { StockDetailResult } from '@/lib/api';
import { Card } from '@/components/ui';
import { ResolutionEmpty, ResolutionRecovery } from './resolution';

export function StockPageBackButton({
  router,
}: {
  router: {
    back(): void;
    push(href: string): void;
  };
}) {
  return (
    <div className="mb-2">
      <button
        type="button"
        onClick={() => {
          if (typeof window !== 'undefined' && window.history.length > 1) {
            router.back();
          } else {
            router.push('/watchlist');
          }
        }}
        className="inline-flex items-center gap-1 text-[12.5px] text-[var(--color-fg-2)] hover:text-[var(--color-fg)] transition-colors"
      >
        <ChevronLeft className="w-3.5 h-3.5" strokeWidth={1.5} />
        返回
      </button>
    </div>
  );
}

export function StockResolutionStatus({
  requestedStockId,
  effectiveStockId,
  resolvingStock,
  detail,
  symbol,
  watchlistBusy,
  onAddAndAnalyze,
  onAddOnly,
}: {
  requestedStockId: string | null;
  effectiveStockId: string | null;
  resolvingStock: boolean;
  detail: StockDetailResult | null;
  symbol: string;
  watchlistBusy: boolean;
  onAddAndAnalyze: () => Promise<void>;
  onAddOnly: () => Promise<void>;
}) {
  if (requestedStockId || effectiveStockId) return null;

  if (resolvingStock) {
    return (
      <Card className="mb-6">
        <div className="flex items-center gap-2 px-5 py-3.5 text-[13px] text-[var(--color-fg-2)]">
          <Loader2 className="w-3.5 h-3.5 animate-spin" strokeWidth={1.5} />
          正在识别股票…
        </div>
      </Card>
    );
  }

  if (!detail) return null;

  if (detail.candidates.length > 0) {
    return (
      <ResolutionRecovery
        symbol={symbol}
        candidates={detail.candidates}
        onAddAndAnalyze={onAddAndAnalyze}
        onAddOnly={onAddOnly}
        busy={watchlistBusy}
      />
    );
  }

  return <ResolutionEmpty symbol={symbol} />;
}
