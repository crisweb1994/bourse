'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { Search, Plus, Loader2, X, ArrowUpRight } from 'lucide-react';
import { useRouter } from 'next/navigation';
import type { StockSearchResult } from '@bourse/shared-types';
import { searchStocks, addToWatchlist, ApiError } from '@/lib/api';
import { MARKET_LABELS } from '@/lib/constants';
import { InputShell, Input, Kbd, toast } from '@/components/ui';
import { cn } from '@/lib/utils';

export function StockSearch({
  onAdded,
  className,
  autoFocus = true,
  placeholder = '输入股票代码或公司名',
}: {
  onAdded?: () => void;
  className?: string;
  autoFocus?: boolean;
  placeholder?: string;
}) {
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<StockSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [adding, setAdding] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const handleSearch = useCallback((value: string) => {
    setQuery(value);
    clearTimeout(timerRef.current);
    if (!value.trim()) {
      setResults([]);
      setOpen(false);
      return;
    }
    timerRef.current = setTimeout(async () => {
      setLoading(true);
      try {
        const data = await searchStocks(value.trim());
        setResults(data);
        setOpen(data.length > 0);
      } catch {
        setResults([]);
      } finally {
        setLoading(false);
      }
    }, 300);
  }, []);

  const handleAdd = async (stock: StockSearchResult, e?: React.MouseEvent) => {
    e?.stopPropagation();
    const key = stock.yahooSymbol || stock.symbol;
    setAdding(key);
    try {
      await addToWatchlist(stock);
      onAdded?.();
      window.dispatchEvent(new Event('watchlist:changed'));
      toast.success(`已加入自选 · ${stock.symbol}`);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        toast.error(`${stock.symbol} 已在自选股中`);
      } else {
        toast.error('添加失败，请重试');
      }
    } finally {
      setAdding(null);
    }
  };

  const handleOpen = (stock: StockSearchResult) => {
    const routeSymbol = encodeURIComponent(stock.yahooSymbol || stock.symbol);
    router.push(`/stock/${routeSymbol}`);
    setOpen(false);
  };

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  return (
    <div ref={containerRef} className={cn('relative', className)}>
      <InputShell
        sans
        leading={<Search />}
        trailing={
          loading ? (
            <Loader2
              className="w-3.5 h-3.5 animate-spin text-[var(--color-fg-3)]"
              strokeWidth={1.5}
            />
          ) : query ? (
            <button
              type="button"
              onClick={() => {
                setQuery('');
                setResults([]);
                setOpen(false);
              }}
              className="text-[var(--color-fg-3)] hover:text-[var(--color-fg)] p-1"
              aria-label="Clear"
            >
              <X className="w-3.5 h-3.5" strokeWidth={1.5} />
            </button>
          ) : (
            <Kbd>⌘ K</Kbd>
          )
        }
      >
        <Input
          type="text"
          value={query}
          onChange={(e) => handleSearch(e.target.value)}
          onFocus={() => results.length > 0 && setOpen(true)}
          placeholder={placeholder}
          autoFocus={autoFocus}
        />
      </InputShell>


      {open && (results.length > 0 || (!loading && query)) && (
        <div
          className={
            'absolute left-0 right-0 top-full z-50 mt-1.5 max-h-[360px] overflow-y-auto ' +
            'rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-bg)]'
          }
        >
          {results.length === 0 ? (
            <div className="px-4 py-6 text-center text-[13px] text-[var(--color-fg-3)]">
              未找到匹配的股票
            </div>
          ) : (
            <>
              {results.map((stock) => {
                const key = stock.yahooSymbol || stock.symbol;
                const isAdding = adding === key;
                return (
                  <div
                    key={key}
                    role="button"
                    tabIndex={0}
                    onClick={() => handleOpen(stock)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        handleOpen(stock);
                      }
                    }}
                    className={cn(
                      'grid grid-cols-[120px_minmax(0,1fr)_60px_32px] gap-3 items-center w-full text-left',
                      'px-4 py-3 border-b border-[var(--color-border-soft)] last:border-b-0',
                      'transition-colors hover:bg-[var(--color-surface-hover)]',
                    )}
                  >
                    <span className="font-mono text-[13px] font-medium tracking-[0.02em] truncate">
                      {stock.symbol}
                    </span>
                    <span className="text-[13.5px] text-[var(--color-fg)] truncate min-w-0">
                      {stock.name}
                    </span>
                    <span className="font-mono text-[11.5px] text-[var(--color-fg-3)] text-right">
                      {MARKET_LABELS[stock.market] || stock.market}
                    </span>
                    <button
                      type="button"
                      onClick={(e) => handleAdd(stock, e)}
                      disabled={isAdding}
                      title="加入自选"
                      className={cn(
                        'w-7 h-7 grid place-items-center rounded-[6px] ',
                        'border border-[var(--color-border)] text-[var(--color-fg-2)]',
                        'hover:bg-[var(--color-fg)] hover:text-[var(--color-bg)] hover:border-[var(--color-fg)] transition-colors',
                      )}
                    >
                      {isAdding ? (
                        <Loader2
                          className="w-3.5 h-3.5 animate-spin"
                          strokeWidth={1.5}
                        />
                      ) : (
                        <Plus className="w-3.5 h-3.5" strokeWidth={1.5} />
                      )}
                    </button>
                  </div>
                );
              })}
              <div className="px-4 py-2.5 bg-[var(--color-surface-2)] border-t border-[var(--color-border-soft)] flex gap-4 items-center font-mono text-[11px] text-[var(--color-fg-3)]">
                <span className="flex items-center gap-1.5">
                  <Kbd>↵</Kbd> 打开
                </span>
                <span className="flex items-center gap-1.5">
                  <Kbd>+</Kbd> 加入自选
                </span>
                <span className="ml-auto">共 {results.length} 条匹配</span>
              </div>
            </>
          )}
        </div>
      )}

      <ArrowUpRight className="hidden" />
    </div>
  );
}
