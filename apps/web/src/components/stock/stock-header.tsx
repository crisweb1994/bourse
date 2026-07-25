'use client';

/**
 * PR-4 · Stock workspace header (Style A · Editorial Refined).
 *
 * Renders symbol + market pill + name + quote strip + watchlist toggle +
 * last-analysis popover. Quote / profile are fetched in parallel; both are
 * non-blocking — a degraded response simply hides those fields.
 *
 * History popover (T2 = b, locked 2026-05-23): clicking the last-analysis
 * chip expands a list of the most recent 5 analyses. Selecting one updates
 * the URL `?analysisId=` parameter; the page effect picks it up.
 */
import { useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Star, Loader2, ChevronDown, Clock, Share2 } from 'lucide-react';
import {
  type AnalysisHistoryItemDto,
  type StockQuoteDto,
  type StockProfileDto,
} from '@/lib/api';
import { Pill, SectionTag } from '@/components/ui';
import { ANALYSIS_TYPE_LABELS } from '@/lib/constants';
import { cn } from '@/lib/utils';

const SIGNAL_LABEL: Record<string, string> = {
  BULLISH: '看多',
  BEARISH: '看空',
  NEUTRAL: '中性',
};
const CONF_LABEL: Record<string, string> = { HIGH: '高', MEDIUM: '中', LOW: '低' };

const MARKET_STATE_LABEL: Record<string, string> = {
  REGULAR: '开盘中',
  PRE: '盘前',
  POST: '盘后',
  PREPRE: '盘前',
  POSTPOST: '盘后',
  CLOSED: '已收盘',
};

interface Props {
  symbol: string;
  market: string;
  exchange?: string;
  name: string;
  /** null when URL has no stockId AND lookup didn't find one yet. */
  stockId: string | null;
  /** null when not on user's watchlist (PR-4 doesn't toggle — placeholder). */
  inWatchlist: boolean;
  onToggleWatchlist?: () => void;
  watchlistBusy?: boolean;
  /** Most recent 5 analyses for this stock. Empty when none. */
  recentAnalyses: AnalysisHistoryItemDto[];
  /**
   * Quote + profile fetched by the parent page via getStockDetail so the
   * header doesn't issue a duplicate request. `null` = page still loading;
   * `{degraded}` = backend returned a degraded payload.
   */
  quote: StockQuoteDto | null;
  profile: StockProfileDto | null;
}

export function StockHeader({
  symbol,
  market,
  exchange,
  name,
  stockId,
  inWatchlist,
  onToggleWatchlist,
  watchlistBusy,
  recentAnalyses,
  quote,
  profile,
}: Props) {

  return (
    <header className="mb-6">
      <div className="flex flex-wrap items-start justify-between gap-3 sm:items-end">
        <div className="min-w-0">
          <SectionTag className="mb-3">股票分析</SectionTag>
          <div className="flex items-baseline gap-3 flex-wrap">
            <h1 className="font-mono text-[32px] font-medium tracking-[-0.02em] leading-none m-0">
              {symbol}
            </h1>
            {market && <Pill>{market}</Pill>}
            {exchange && <Pill>{exchange}</Pill>}
          </div>
          <p className="mt-2 text-[14px] text-[var(--color-fg-2)] m-0">
            {name}
          </p>
        </div>
        <div className="flex w-full items-center gap-2 sm:w-auto sm:justify-end">
          <WatchlistToggle
            on={inWatchlist}
            busy={!!watchlistBusy}
            disabled={!onToggleWatchlist}
            onClick={onToggleWatchlist}
          />
          <ShareButton symbol={symbol} />
        </div>
      </div>

      {/* Quote strip — only when stockId present (else header is the empty
          shell for resolution flow). */}
      {stockId && (
        <div
          className={
            'mt-5 flex flex-wrap items-center gap-x-6 gap-y-2 ' +
            'border-y border-[var(--color-border)] py-3'
          }
        >
          <QuoteBlock quote={quote} />
          <MarketStateBlock state={quoteMarketState(quote)} />
          <ProfileMeta profile={profile} />
          <span className="flex-1" />
          {recentAnalyses.length > 0 && (
            <LastAnalysisChip
              recent={recentAnalyses}
              currentSymbol={symbol}
            />
          )}
        </div>
      )}
    </header>
  );
}

function ShareButton({ symbol }: { symbol: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        const href = window.location.href;
        if (navigator.share) {
          await navigator
            .share({ title: `${symbol} 股票分析`, url: href })
            .catch(() => undefined);
          return;
        }
        await navigator.clipboard?.writeText(href).catch(() => undefined);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1600);
      }}
      className={
        'inline-flex items-center gap-1.5 rounded-[var(--radius-btn)] ' +
        'border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1.5 ' +
        'text-[12.5px] text-[var(--color-fg)] hover:bg-[var(--color-surface-hover)]'
      }
    >
      <Share2 className="h-3.5 w-3.5" strokeWidth={1.5} />
      {copied ? '已复制' : '分享'}
    </button>
  );
}

// ----------------------------------------------------------------------------
// QuoteBlock
// ----------------------------------------------------------------------------
function QuoteBlock({ quote }: { quote: StockQuoteDto | null }) {
  if (!quote) {
    return (
      <span className="text-[12px] text-[var(--color-fg-3)] font-mono inline-flex items-center gap-1.5">
        <Loader2 className="w-3 h-3 animate-spin" strokeWidth={1.5} />
        行情加载中…
      </span>
    );
  }
  if (quote.degraded) {
    return (
      <span className="text-[12px] text-[var(--color-fg-3)] font-mono">
        行情暂不可用
      </span>
    );
  }
  const up = quote.change >= 0;
  const sign = up ? '+' : '';
  return (
    <div className="flex items-baseline gap-3">
      <span className="font-mono text-[22px] font-medium tracking-[-0.01em]">
        {formatPrice(quote.price, quote.currency)}
      </span>
      <span
        className={cn(
          'font-mono text-[13px]',
          up ? 'text-[var(--color-accent-600)]' : 'text-[var(--color-warn)]',
        )}
      >
        {sign}
        {quote.change.toFixed(2)} ({sign}
        {quote.changePct.toFixed(2)}%)
      </span>
    </div>
  );
}

function quoteMarketState(q: StockQuoteDto | null): string | null {
  if (!q || q.degraded) return null;
  return q.marketState;
}

function MarketStateBlock({ state }: { state: string | null }) {
  if (!state) return null;
  const isLive = state === 'REGULAR';
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 font-mono text-[11.5px]',
        isLive ? 'text-[var(--color-accent-600)]' : 'text-[var(--color-fg-2)]',
      )}
    >
      <span
        className={cn(
          'h-1.5 w-1.5 rounded-full',
          isLive
            ? 'bg-[var(--color-accent)]'
            : 'bg-[var(--color-fg-4)]',
        )}
      />
      {MARKET_STATE_LABEL[state] ?? state}
    </span>
  );
}

// ----------------------------------------------------------------------------
// ProfileMeta
// ----------------------------------------------------------------------------
function ProfileMeta({ profile }: { profile: StockProfileDto | null }) {
  if (!profile || profile.degraded) return null;
  const items: Array<{ k: string; v: string }> = [];
  if (typeof profile.marketCap === 'number') {
    items.push({ k: '市值', v: formatMarketCap(profile.marketCap) });
  }
  if (profile.nextEarningsDate) {
    items.push({ k: '下次财报', v: profile.nextEarningsDate.slice(0, 10) });
  }
  if (profile.sector) {
    items.push({
      k: '板块',
      v: profile.industry
        ? `${profile.sector} · ${profile.industry}`
        : profile.sector,
    });
  }
  if (items.length === 0) return null;
  return (
    <>
      {items.map((item) => (
        <span
          key={item.k}
          className="font-mono text-[11.5px] text-[var(--color-fg-3)] inline-flex items-baseline gap-1"
        >
          <span>{item.k}</span>
          <span className="text-[var(--color-fg-2)]">{item.v}</span>
        </span>
      ))}
    </>
  );
}

// ----------------------------------------------------------------------------
// Watchlist toggle
// ----------------------------------------------------------------------------
function WatchlistToggle({
  on,
  busy,
  disabled,
  onClick,
}: {
  on: boolean;
  busy: boolean;
  disabled: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || busy}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-[var(--radius-btn)] ' +
          'border px-3 py-1.5 text-[12.5px] transition-colors',
        on
          ? 'border-[var(--color-accent-line)] bg-[var(--color-accent-soft)] text-[var(--color-accent-600)]'
          : 'border-[var(--color-border)] bg-[var(--color-bg)] text-[var(--color-fg-2)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-fg)]',
        disabled && 'opacity-60 cursor-not-allowed',
      )}
    >
      {busy ? (
        <Loader2 className="w-3.5 h-3.5 animate-spin" strokeWidth={1.5} />
      ) : (
        <Star
          className={cn('w-3.5 h-3.5', on && 'fill-current')}
          strokeWidth={1.5}
        />
      )}
      {on ? '已自选' : '加入自选'}
    </button>
  );
}

// ----------------------------------------------------------------------------
// LastAnalysisChip — collapsed entry + popover history list (T2=b)
// ----------------------------------------------------------------------------
function LastAnalysisChip({
  recent,
  currentSymbol,
}: {
  recent: AnalysisHistoryItemDto[];
  currentSymbol: string;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const latest = recent[0];

  useEffect(() => {
    if (!open) return;
    function onClickOutside(ev: MouseEvent) {
      if (!ref.current?.contains(ev.target as Node)) setOpen(false);
    }
    function onKey(ev: KeyboardEvent) {
      if (ev.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onClickOutside);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClickOutside);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!latest) return null;

  const activeId = searchParams.get('analysisId');

  const switchTo = (a: AnalysisHistoryItemDto) => {
    setOpen(false);
    const params = new URLSearchParams(searchParams.toString());
    params.set('analysisId', a.id);
    router.replace(`?${params.toString()}`);
  };

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={
          'inline-flex items-center gap-2 rounded-[var(--radius-btn)] ' +
          'border border-[var(--color-border)] bg-[var(--color-bg)] ' +
          'px-3 py-1.5 text-[12px] text-[var(--color-fg-2)] ' +
          'hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-fg)]'
        }
      >
        <Clock className="w-3 h-3" strokeWidth={1.5} />
        <span>上次分析 · {timeAgo(latest.generatedAt ?? latest.createdAt)}</span>
        {latest.overallSignal && (
          <span className="text-[var(--color-accent-600)] font-medium">
            {ANALYSIS_TYPE_LABELS[latest.analysisType] ??
              latest.analysisType}{' '}
            ·{' '}
            {SIGNAL_LABEL[latest.overallSignal] ?? latest.overallSignal}
            {latest.overallConfidence
              ? `·${CONF_LABEL[latest.overallConfidence] ?? latest.overallConfidence}`
              : ''}
          </span>
        )}
        <ChevronDown
          className={cn(
            'w-3 h-3 transition-transform',
            open && 'rotate-180',
          )}
          strokeWidth={1.5}
        />
      </button>

      {open && (
        <div
          role="menu"
          className={
            'absolute right-0 z-20 mt-2 w-80 rounded-[var(--radius-card)] ' +
            'border border-[var(--color-border)] bg-[var(--color-bg)] ' +
            'shadow-sm'
          }
        >
          <div
            className={
              'px-3 py-2 border-b border-[var(--color-border-soft)] ' +
              'font-mono text-[10.5px] uppercase tracking-[0.06em] ' +
              'text-[var(--color-fg-3)]'
            }
          >
            最近 {recent.length} 次分析
          </div>
          <ul className="m-0 list-none">
            {recent.map((a) => {
              const isActive = a.id === activeId;
              const typeLabel =
                ANALYSIS_TYPE_LABELS[a.analysisType] ?? a.analysisType;
              const sigLabel = a.overallSignal
                ? SIGNAL_LABEL[a.overallSignal] ?? a.overallSignal
                : null;
              return (
                <li key={a.id}>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => switchTo(a)}
                    className={cn(
                      'flex w-full items-start justify-between gap-3 px-3 py-2 text-left',
                      'hover:bg-[var(--color-surface-hover)]',
                      isActive && 'bg-[var(--color-surface-hover)]',
                    )}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5 text-[12.5px]">
                        <span className="font-medium text-[var(--color-fg)]">
                          {typeLabel}
                        </span>
                        {sigLabel && (
                          <span className="text-[11.5px] text-[var(--color-accent-600)]">
                            · {sigLabel}
                            {a.overallConfidence
                              ? `·${CONF_LABEL[a.overallConfidence] ?? a.overallConfidence}`
                              : ''}
                          </span>
                        )}
                        {a.status === 'IN_PROGRESS' && (
                          <Pill className="ml-1">进行中</Pill>
                        )}
                        {a.status === 'FAILED' && (
                          <Pill variant="danger" className="ml-1">
                            失败
                          </Pill>
                        )}
                      </div>
                      <div className="mt-0.5 font-mono text-[10.5px] text-[var(--color-fg-3)]">
                        {timeAgo(a.generatedAt ?? a.createdAt)} · {a.aiModel ?? a.aiProvider ?? '—'}
                      </div>
                    </div>
                    {isActive && (
                      <span className="font-mono text-[10px] text-[var(--color-fg-3)] mt-0.5">
                        当前
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

// ----------------------------------------------------------------------------
// formatters
// ----------------------------------------------------------------------------
function formatPrice(price: number, currency: string): string {
  const sym = currency === 'USD' ? '$' : currency === 'HKD' ? 'HK$' :
              currency === 'CNY' ? '¥' : currency === 'JPY' ? '¥' :
              currency === 'GBP' ? '£' : currency === 'EUR' ? '€' : '';
  return `${sym}${price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatMarketCap(n: number): string {
  if (n >= 1e12) return `${(n / 1e12).toFixed(2)}T`;
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(0)}M`;
  return n.toLocaleString();
}

function timeAgo(iso: string | null | undefined): string {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '—';
  const diffSec = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (diffSec < 60) return `${diffSec} 秒前`;
  const min = Math.floor(diffSec / 60);
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day} 天前`;
  const month = Math.floor(day / 30);
  if (month < 12) return `${month} 个月前`;
  return `${Math.floor(month / 12)} 年前`;
}
