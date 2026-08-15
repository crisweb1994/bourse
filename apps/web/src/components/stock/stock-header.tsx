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
import type { ReactNode } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  ArrowUpRight,
  CalendarDays,
  ChevronDown,
  Clock,
  Loader2,
  MessageSquareText,
  Share2,
  Sparkles,
  Star,
} from 'lucide-react';
import {
  type AnalysisHistoryItemDto,
  type StockQuoteDto,
  type StockProfileDto,
  type StockNewsItem,
} from '@/lib/api';
import { Button, Pill, SectionTag } from '@/components/ui';
import { CONFIDENCE_LABELS, FOCUS_WINDOW_LABELS, MODE_LABELS, SIGNAL_LABELS } from '@/lib/constants';
import { cn } from '@/lib/utils';

const SIGNAL_LABEL = SIGNAL_LABELS;
const CONF_LABEL = CONFIDENCE_LABELS;

/**
 * Pull the headline out of a V2 analysis summary.
 */
function readOneLiner(summaryJson: unknown): string | undefined {
  if (typeof summaryJson !== 'object' || summaryJson === null) return undefined;
  const v = (summaryJson as { headline?: unknown }).headline;
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

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
  currency?: string;
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
  /** Opens the stock-scoped Chat entry from the research header. */
  onOpenResearch?: () => void;
  /** Opens the formal analysis dialog from the research header. */
  onOpenAnalysis?: () => void;
  /**
   * Recent announcements (filings + web-search news), fetched via a dedicated
   * async endpoint so it never blocks the price strip. `loading` renders a
   * skeleton; an empty/degraded result hides the row entirely.
   */
  news?: { items: StockNewsItem[]; loading: boolean; degraded: boolean };
}

export function StockHeader({
  symbol,
  market,
  exchange,
  name,
  currency,
  stockId,
  inWatchlist,
  onToggleWatchlist,
  watchlistBusy,
  recentAnalyses,
  quote,
  profile,
  onOpenResearch,
  onOpenAnalysis,
  news,
}: Props) {
  return (
    <header className="mb-8" aria-label={`${symbol} 股票研究概览`}>
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-5">
        <div className="min-w-0">
          <SectionTag className="mb-3">股票研究</SectionTag>
          <div className="flex flex-wrap items-end gap-x-3 gap-y-2">
            <h1 className="m-0 font-mono text-[36px] font-medium leading-none tracking-[-0.025em]">
              {symbol}
            </h1>
            <div className="flex items-center gap-1.5 pb-1">
              {market && <Pill>{market}</Pill>}
              {exchange && <Pill>{exchange}</Pill>}
            </div>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1">
            <p className="m-0 text-[15px] font-medium text-[var(--color-fg)]">
              {name}
            </p>
            {currency && (
              <span className="font-mono text-[11px] text-[var(--color-fg-3)]">
                · {currency}
              </span>
            )}
          </div>
        </div>
        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:justify-end">
          {stockId && onOpenResearch && (
            <Button
              type="button"
              variant="primary"
              size="md"
              onClick={onOpenResearch}
            >
              <MessageSquareText className="h-3.5 w-3.5" strokeWidth={1.5} />
              研究对话
            </Button>
          )}
          {stockId && onOpenAnalysis && (
            <Button
              type="button"
              variant="secondary"
              size="md"
              onClick={onOpenAnalysis}
            >
              <Sparkles className="h-3.5 w-3.5" strokeWidth={1.5} />
              {recentAnalyses.length > 0 ? '新分析' : '开始分析'}
            </Button>
          )}
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
        <>
          <StockFactBand quote={quote} profile={profile} currency={currency} />
          <ResearchPulse recent={recentAnalyses} currentSymbol={symbol} />
        </>
      )}

      {/* Announcements row — async, never blocks the quote strip above.
          Skeleton while loading; hidden when empty/degraded so a missing
          source leaves no gap. */}
      {stockId && news && <AnnouncementsRow news={news} />}
    </header>
  );
}

// ----------------------------------------------------------------------------
// StockFactBand — a compact, scan-friendly layer between identity and research
// ----------------------------------------------------------------------------
function StockFactBand({
  quote,
  profile,
  currency,
}: {
  quote: StockQuoteDto | null;
  profile: StockProfileDto | null;
  currency?: string;
}) {
  const quoteCurrency =
    quote && !quote.degraded ? quote.currency : undefined;
  const facts = profileFacts(profile);

  return (
    <section
      className="mt-6 overflow-hidden border-y border-[var(--color-border)] bg-[var(--color-border-soft)]"
      aria-label="行情与公司资料"
    >
      <div className="flex flex-wrap gap-px">
        <QuoteBlock quote={quote} />
        <MarketStateFact quote={quote} />
        <FactCell label="币种" value={currency || quoteCurrency || '—'} />
        {facts.map((fact) => (
          <FactCell key={fact.label} label={fact.label} value={fact.value} />
        ))}
      </div>
    </section>
  );
}

function FactCell({
  label,
  value,
  className,
}: {
  label: string;
  value: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'min-w-[150px] flex-[1_1_150px] bg-[var(--color-bg-elev)] px-4 py-4 sm:px-5',
        className,
      )}
    >
      <div className="text-[10.5px] text-[var(--color-fg-3)]">{label}</div>
      <div className="mt-2 truncate font-mono text-[13px] text-[var(--color-fg)]">
        {value}
      </div>
    </div>
  );
}

function MarketStateFact({ quote }: { quote: StockQuoteDto | null }) {
  const state = quoteMarketState(quote);
  const isLive = state === 'REGULAR';
  const value = !quote
    ? '行情加载中…'
    : quote.degraded
      ? '行情暂不可用'
      : MARKET_STATE_LABEL[state ?? ''] ?? state ?? '未知';

  return (
    <FactCell
      label="市场状态"
      value={
        <span
          className={cn(
            'inline-flex items-center gap-1.5',
            isLive
              ? 'text-[var(--color-accent-600)]'
              : 'text-[var(--color-fg-2)]',
          )}
        >
          <span
            className={cn(
              'h-1.5 w-1.5 shrink-0 rounded-full',
              isLive ? 'bg-[var(--color-accent)]' : 'bg-[var(--color-fg-4)]',
            )}
          />
          {value}
        </span>
      }
    />
  );
}

function profileFacts(
  profile: StockProfileDto | null,
): Array<{ label: string; value: string }> {
  if (!profile || profile.degraded) return [];

  const facts: Array<{ label: string; value: string }> = [];
  if (typeof profile.marketCap === 'number') {
    facts.push({ label: '市值', value: formatMarketCap(profile.marketCap) });
  }
  if (profile.sector) {
    facts.push({
      label: '行业',
      value: profile.industry
        ? `${profile.sector} · ${profile.industry}`
        : profile.sector,
    });
  }
  if (profile.nextEarningsDate) {
    facts.push({
      label: '下次财报期',
      value: profile.nextEarningsDate.slice(0, 10),
    });
  }
  if (profile.lastReportedDate) {
    facts.push({
      label: '上次披露',
      value: profile.lastReportedDate.slice(0, 10),
    });
  }
  return facts;
}

// ----------------------------------------------------------------------------
// ResearchPulse — makes the research state explicit instead of hiding it in
// a long one-line history chip.
// ----------------------------------------------------------------------------
function ResearchPulse({
  recent,
  currentSymbol,
}: {
  recent: AnalysisHistoryItemDto[];
  currentSymbol: string;
}) {
  const latest = recent[0];
  const oneLiner = readOneLiner(latest?.summaryJson);
  const typeLabel = latest
    ? `${MODE_LABELS[latest.mode]} · ${FOCUS_WINDOW_LABELS[latest.focusWindow]}`
    : null;

  return (
    <section
      className="border-b border-[var(--color-border)] bg-[var(--color-bg)] px-4 py-4 sm:px-5"
      aria-label="最近研究"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-5">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <div className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-[var(--radius-btn)] bg-[var(--color-accent-soft)] text-[var(--color-accent-600)]">
            <Clock className="h-3.5 w-3.5" strokeWidth={1.5} />
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px]">
              <span className="font-medium text-[var(--color-fg)]">最近研究</span>
              {latest ? (
                <span className="font-mono text-[10.5px] text-[var(--color-fg-3)]">
                  {typeLabel} · {timeAgo(latest.completedAt ?? latest.createdAt)}
                </span>
              ) : (
                <span className="font-mono text-[10.5px] text-[var(--color-fg-3)]">
                  尚未运行分析
                </span>
              )}
              {latest?.overallSignal && (
                <span
                  className={cn(
                    'font-medium',
                    signalTone(latest.overallSignal),
                  )}
                >
                  {SIGNAL_LABEL[latest.overallSignal] ?? latest.overallSignal}
                  {latest.overallConfidence
                    ? ` · ${CONF_LABEL[latest.overallConfidence] ?? latest.overallConfidence}`
                    : ''}
                </span>
              )}
            </div>
            <p className="mt-1.5 m-0 line-clamp-2 max-w-[820px] break-words text-[12.5px] leading-[1.55] text-[var(--color-fg-2)]">
              {oneLiner ||
                (latest
                  ? '这次分析没有摘要，可打开历史查看完整报告。'
                  : '还没有研究基线，从一次 AI 分析或研究对话开始。')}
            </p>
          </div>
        </div>
        {latest && (
          <LastAnalysisChip recent={recent} currentSymbol={currentSymbol} />
        )}
      </div>
    </section>
  );
}

function signalTone(signal: string | null | undefined): string {
  if (signal === 'POSITIVE') return 'text-[var(--color-accent-600)]';
  if (signal === 'CAUTIOUS') return 'text-[var(--color-danger)]';
  return 'text-[var(--color-fg-2)]';
}

// ----------------------------------------------------------------------------
// AnnouncementsRow — filings + web-search news
// ----------------------------------------------------------------------------
function AnnouncementsRow({
  news,
}: {
  news: { items: StockNewsItem[]; loading: boolean; degraded: boolean };
}) {
  if (news.loading) {
    return (
      <div
        className="mt-3 flex flex-wrap items-center gap-2"
        aria-label="正在加载最新公告"
      >
        <span className="mr-1 text-[11px] font-medium text-[var(--color-fg-3)]">
          最新公告
        </span>
        <span className="h-3 w-28 animate-pulse rounded-[var(--radius-pill)] bg-[var(--color-surface-2)]" />
        <span className="h-3 w-20 animate-pulse rounded-[var(--radius-pill)] bg-[var(--color-surface-2)]" />
      </div>
    );
  }
  if (news.items.length === 0) return null;
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      <span className="mr-1 text-[11px] font-medium text-[var(--color-fg-3)]">
        最新公告
      </span>
      {news.items.slice(0, 4).map((item) => (
        <a
          key={item.url}
          href={item.url}
          target="_blank"
          rel="noopener noreferrer"
          className="group inline-flex min-w-0 max-w-full items-center gap-2 rounded-[var(--radius-btn)] border border-[var(--color-border)] bg-[var(--color-bg-elev)] px-2.5 py-1.5 text-[12px] text-[var(--color-fg)] transition-colors hover:bg-[var(--color-surface-hover)]"
          title={item.title}
        >
          <span className="shrink-0 rounded-[var(--radius-pill)] border border-[var(--color-info-line)] bg-[var(--color-info-soft)] px-1.5 py-px font-mono text-[10px] text-[var(--color-info)]">
            {item.formType || (item.kind === 'filing' ? '披露' : '新闻')}
          </span>
          <span className="min-w-0 max-w-[240px] truncate">{item.title}</span>
          {item.source && (
            <span className="shrink-0 font-mono text-[10px] text-[var(--color-fg-3)]">
              {item.source}
            </span>
          )}
          {item.publishedAt && (
            <span className="shrink-0 font-mono text-[10px] text-[var(--color-fg-3)]">
              {item.publishedAt.slice(0, 10)}
            </span>
          )}
          <ArrowUpRight
            className="h-3 w-3 shrink-0 text-[var(--color-fg-3)] transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5"
            strokeWidth={1.5}
          />
        </a>
      ))}
    </div>
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
function QuoteBlock({
  quote,
  className,
}: {
  quote: StockQuoteDto | null;
  className?: string;
}) {
  if (!quote) {
    return (
      <div
        className={cn(
          'min-w-[300px] flex-[2_1_320px] bg-[var(--color-bg-elev)] px-4 py-4 sm:px-5',
          className,
        )}
      >
        <div className="text-[10.5px] text-[var(--color-fg-3)]">最新行情</div>
        <div className="mt-2 inline-flex items-center gap-1.5 font-mono text-[13px] text-[var(--color-fg-3)]">
          <Loader2 className="h-3 w-3 animate-spin" strokeWidth={1.5} />
          行情加载中…
        </div>
      </div>
    );
  }
  if (quote.degraded) {
    return (
      <div
        className={cn(
          'min-w-[300px] flex-[2_1_320px] bg-[var(--color-bg-elev)] px-4 py-4 sm:px-5',
          className,
        )}
      >
        <div className="text-[10.5px] text-[var(--color-fg-3)]">最新行情</div>
        <div className="mt-2 font-mono text-[13px] text-[var(--color-fg-3)]">
          行情暂不可用
        </div>
      </div>
    );
  }
  const up = quote.change >= 0;
  const sign = up ? '+' : '';
  return (
    <div
      className={cn(
        'min-w-[300px] flex-[2_1_320px] bg-[var(--color-bg-elev)] px-4 py-4 sm:px-5',
        className,
      )}
    >
      <div className="text-[10.5px] text-[var(--color-fg-3)]">最新行情</div>
      <div className="mt-1.5 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="font-mono text-[28px] font-medium leading-none tracking-[-0.02em]">
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
      {quote.asOf && (
        <div className="mt-2 inline-flex items-center gap-1.5 font-mono text-[10.5px] text-[var(--color-fg-3)]">
          <CalendarDays className="h-3 w-3" strokeWidth={1.5} />
          数据截至 {timeAgo(quote.asOf)}
        </div>
      )}
    </div>
  );
}

function quoteMarketState(q: StockQuoteDto | null): string | null {
  if (!q || q.degraded) return null;
  return q.marketState;
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
      aria-pressed={on}
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
        aria-haspopup="menu"
        aria-expanded={open}
        title={`${currentSymbol} 最近分析历史`}
        className={
          'inline-flex items-center gap-2 rounded-[var(--radius-btn)] ' +
          'border border-[var(--color-border)] bg-[var(--color-bg)] ' +
          'px-3 py-1.5 text-[12px] text-[var(--color-fg-2)] ' +
          'hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-fg)]'
        }
      >
        <Clock className="w-3 h-3" strokeWidth={1.5} />
        <span>上次研究 · {timeAgo(latest.completedAt ?? latest.createdAt)}</span>
        {latest.overallSignal && (
          <span className="text-[var(--color-accent-600)] font-medium whitespace-nowrap">
            {MODE_LABELS[latest.mode] ?? latest.mode}{' '}
            · {FOCUS_WINDOW_LABELS[latest.focusWindow] ?? latest.focusWindow}{' '}
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
              const typeLabel = `${MODE_LABELS[a.mode]} · ${FOCUS_WINDOW_LABELS[a.focusWindow]}`;
              const sigLabel = a.overallSignal
                ? SIGNAL_LABEL[a.overallSignal] ?? a.overallSignal
                : null;
              const oneLiner = readOneLiner(a.summaryJson);
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
                        {timeAgo(a.completedAt ?? a.createdAt)} · {a.aiModel ?? a.aiProvider ?? '—'}
                      </div>
                      {oneLiner && (
                        <div className="mt-1 text-[11.5px] leading-snug text-[var(--color-fg-2)] line-clamp-2">
                          {oneLiner}
                        </div>
                      )}
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
