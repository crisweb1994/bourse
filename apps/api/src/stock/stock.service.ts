import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  Market,
  type StockHistoryResponse,
  type StockSearchResult,
  STOCK_HISTORY_DAYS_WHITELIST,
} from '@bourse/shared-types';
import type { ResearchMarketDataClient } from '@bourse/market-data';
import { computeTechnicalIndicators, derivePriceSeries } from '@bourse/analysis';
import { PrismaService } from '../prisma/prisma.service';
import { UpsertStockDto } from './stock.dto';
import { MARKET_DATA_CLIENT } from '../connectors/connectors.module';
import { resolveMarketState } from './market-hours';
import { TtlLruCache } from './search-cache';
import { EarningsQueryService } from '../earnings/earnings-query.service';

const CACHE_MAX = 200;
const CACHE_TTL_MS = 5 * 60 * 1000;

// Detail-panel quote/profile DTOs. Per-field degradation: a degraded quote
// still lets a non-degraded profile render and vice-versa.
type QuoteDto =
  | {
      degraded: false;
      price: number;
      change: number;
      changePct: number;
      currency: string;
      marketState: string;
      asOf: string;
    }
  | { degraded: true; reason: string };

type ProfileDto =
  | {
      degraded: false;
      marketCap?: number;
      sector?: string;
      industry?: string;
      nextEarningsDate?: string;
      lastReportedDate?: string;
    }
  | { degraded: true; reason: string };

@Injectable()
export class StockService {
  private readonly cache = new TtlLruCache<string, StockSearchResult[]>(
    CACHE_MAX,
    CACHE_TTL_MS,
  );

  constructor(
    private prisma: PrismaService,
    @Inject(MARKET_DATA_CLIENT) private readonly marketData: ResearchMarketDataClient,
    private readonly earningsQuery: EarningsQueryService,
  ) {}

  async search(query: string): Promise<StockSearchResult[]> {
    const q = query?.trim() ?? '';
    if (!q) return [];

    const cacheKey = q.toLowerCase();
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    const results = (await this.marketData.searchInstruments(q)).data ?? [];

    // Do not turn a transient outage across all providers into five minutes
    // of guaranteed empty search results.
    if (results.length > 0) this.cache.set(cacheKey, results);
    return results;
  }

  async upsert(dto: UpsertStockDto) {
    const market = dto.market as Market;
    return this.prisma.stock.upsert({
      where: {
        symbol_market: { symbol: dto.symbol, market },
      },
      update: {
        name: dto.name,
        exchange: dto.exchange,
        currency: dto.currency,
        yahooSymbol: dto.yahooSymbol,
      },
      create: {
        symbol: dto.symbol,
        market,
        name: dto.name,
        exchange: dto.exchange,
        currency: dto.currency,
        yahooSymbol: dto.yahooSymbol,
      },
    });
  }

  /**
   * PR-3 · /stock/:symbol direct-link resolution.
   * Look up by (symbol, market) — the URL-recoverable identity tuple.
   * Returns null when the stock has not been seen by the system yet;
   * callers then fall back to `search()` for resolution candidates.
   */
  async findBySymbolAndMarket(symbol: string, market: string) {
    const s = (symbol ?? '').trim().toUpperCase();
    const m = (market ?? '').trim().toUpperCase();
    if (!s || !m) return null;
    // Canonical (symbol, market) hit first. But every stock link in the web
    // app routes by `yahooSymbol || symbol` (stock-search / watchlist /
    // history), so CN/HK direct links arrive with the yahoo-suffixed form
    // (`000725.SZ`) while the canonical column stores the bare code
    // (`000725`). Fall back to matching yahooSymbol within the same market so
    // those links resolve instead of silently 404'ing the quote panel.
    return (
      (await this.prisma.stock.findUnique({
        where: { symbol_market: { symbol: s, market: m as Market } },
      })) ??
      (await this.prisma.stock.findFirst({
        where: { yahooSymbol: s, market: m as Market },
      }))
    );
  }

  /**
   * plan-v2 §12.1 — single merged detail endpoint replacing the legacy
   * lookup / :id/quote / :id/profile triple. Returns the canonical Stock
   * row (when known) plus a live quote + profile snapshot fetched in
   * parallel. On unknown (symbol, market), `stock` is null and
   * `candidates` carries provider-search results so the UI can offer
   * "add to watchlist + analyze" recovery.
   *
   * Quote / profile degradation is per-field, not whole-response: each
   * carries its own `{ degraded, reason }` marker so a stock with valid
   * quote but missing profile still renders most of the panel.
   */
  /**
   * Chart history for the stock page (visualization §五⑦ / D3).
   *
   * P1 invariant: every indicator is computed server-side by the SAME pure
   * functions the analysis snapshot uses; the frontend only renders. Days are
   * whitelisted to the supported chart windows (default 365 = fixed chart
   * window per D1). Does not require a DB stock row (design R-7) — resolves
   * straight through the capability router, so first-visit symbols work.
   */
  async getChartHistory(
    symbol: string,
    market: string,
    days?: number,
  ): Promise<StockHistoryResponse> {
    const normalizedMarket = market.trim().toUpperCase();
    if (normalizedMarket !== 'US' && normalizedMarket !== 'CN' && normalizedMarket !== 'HK') {
      throw new BadRequestException('market must be one of US | CN | HK');
    }
    const window =
      days !== undefined
        ? (STOCK_HISTORY_DAYS_WHITELIST as readonly number[]).find((d) => d === days)
        : 365;
    if (window === undefined) {
      throw new BadRequestException(
        `days must be one of ${STOCK_HISTORY_DAYS_WHITELIST.join(' | ')}`,
      );
    }

    // URL symbols arrive suffixed for CN/HK (e.g. 600519.SS / 0700.HK) while
    // the capability router expects the bare code (DB stores bare symbols;
    // the detail endpoint works because it resolves through the DB row —
    // this route stays DB-free by design R-7, so normalize here). US symbols
    // are NOT stripped: dots are part of the ticker (BRK.B).
    const providerSymbol =
      normalizedMarket === 'US'
        ? symbol
        : symbol.split('.')[0]!;
    const instrumentId = `${normalizedMarket}:${providerSymbol}`;
    const to = new Date().toISOString().slice(0, 10);
    const from = new Date(Date.now() - window * 86_400_000).toISOString().slice(0, 10);
    const result = await this.marketData.getHistory(
      { instrumentId, from, to, interval: '1d' },
      { timeoutMs: 15_000 },
    );
    const bars = Array.isArray(result.data) ? result.data : [];
    if (bars.length === 0) {
      throw new NotFoundException('暂无行情历史数据');
    }

    const historyTier = (result.citations[0] as { qualityTier?: string } | undefined)
      ?.qualityTier;
    const priceSeries = derivePriceSeries(bars, (historyTier ?? 'B') as 'A' | 'B' | 'C' | 'D' | 'E');
    if (!priceSeries) {
      throw new NotFoundException('行情历史数据不可用');
    }
    const technical = computeTechnicalIndicators({ bars });

    return {
      priceSeries,
      technical: technical.indicators,
      provenance: { history: priceSeries.sourceTier },
    };
  }

  async getDetail(symbol: string, market: string) {
    const stock = await this.findBySymbolAndMarket(symbol, market);
    if (!stock) {
      const normalizedMarket = market.trim().toUpperCase();
      const searchSymbol = normalizeDetailSearchSymbol(symbol, normalizedMarket);
      const candidates = (await this.search(searchSymbol)).filter(
        (candidate) => candidate.market.trim().toUpperCase() === normalizedMarket,
      );
      return { stock: null, quote: null, profile: null, candidates };
    }

    // Invariant #2 "fetch 一次": one getQuote drives both the quote and the
    // marketCap on the profile — the FinancePort bundles marketCap into the
    // Quote (Yahoo via summaryDetail, CN via Tencent).
    const { quote, profile } = await this.fetchQuoteAndProfile(stock);
    return { stock, quote, profile, candidates: [] as const };
  }

  private async fetchQuoteAndProfile(stock: {
    id: string;
    symbol: string;
    market: string;
  }): Promise<{ quote: QuoteDto; profile: ProfileDto }> {
    const market = stock.market.trim().toUpperCase();
    if (market !== 'US' && market !== 'CN' && market !== 'HK') {
      const reason = 'UNSUPPORTED_MARKET';
      return {
        quote: { degraded: true, reason },
        profile: { degraded: true, reason },
      };
    }

    const instrumentId = `${market}:${stock.symbol}`;
    let env;
    try {
      env = await this.marketData.getQuote(instrumentId);
    } catch {
      const reason = 'UPSTREAM_FAILED';
      return {
        quote: { degraded: true, reason },
        profile: { degraded: true, reason },
      };
    }

    const q = env?.data;
    // emptyQuote sentinel carries price=NaN; the real reason rides on warnings.
    if (!q || !Number.isFinite(q.price)) {
      const reason = env?.warnings?.[0]?.code ?? 'UPSTREAM_FAILED';
      return {
        quote: { degraded: true, reason },
        profile: { degraded: true, reason },
      };
    }

    const change = q.change ?? 0;
    const prevClose = q.previousClose ?? q.price - change;
    const changePct = q.changePct ?? (prevClose ? (change / prevClose) * 100 : 0);
    const quote: QuoteDto = {
      degraded: false,
      price: q.price,
      change,
      changePct,
      currency: q.currency,
      // Authoritative session state first: Yahoo (US/HK) reports it via the
      // crumb'd price module. When the source omits it (CN, or a Yahoo crumb
      // miss) fall back to deriving it from the exchange's trading session in
      // the exchange's own timezone — q.timestamp (real last-trade time) then
      // doubles as a holiday guard. See market-hours.ts.
      marketState:
        marketStatusToLabel(q.marketStatus) ??
        resolveMarketState(market, new Date(), q.timestamp),
      asOf: q.timestamp,
    };

    const marketCap = typeof q.marketCap === 'number' ? q.marketCap : undefined;

    // Fan out the remaining profile fields in parallel, each shielded so a
    // single source outage cannot void the others. sector/industry come from
    // the CompanyProfile port; nextEarningsDate is the soonest future fiscal
    // period-end from earnings consensus (forward-looking, not the call date);
    // lastReportedDate is the most recent already-disclosed period from the
    // earnings module. All are best-effort: undefined just hides the field.
    // Each call is wrapped in an async IIFE so a synchronous throw (e.g. a
    // port method that is undefined in a partial test double) becomes a
    // rejected promise rather than escaping Promise.allSettled.
    const [profileSettled, earningsSettled, lastReportedSettled] =
      await Promise.allSettled([
        (async () => this.marketData.getProfile(instrumentId))(),
        (async () => this.marketData.getEarningsConsensus(instrumentId))(),
        (async () => this.earningsQuery.latest(stock.id))(),
      ]);

    const companyProfile =
      profileSettled.status === 'fulfilled' ? profileSettled.value?.data : undefined;
    const sector = companyProfile?.sector;
    const industry = companyProfile?.industry;

    const nextEarningsDate = this.pickNextEarningsDate(
      earningsSettled.status === 'fulfilled' ? earningsSettled.value?.data : undefined,
    );

    const lastReportedResp =
      lastReportedSettled.status === 'fulfilled' ? lastReportedSettled.value : undefined;
    const lastReportedDate =
      lastReportedResp?.available && lastReportedResp.card
        ? lastReportedResp.card.periodEndOn
        : undefined;

    const profile: ProfileDto =
      marketCap !== undefined ||
      sector !== undefined ||
      nextEarningsDate !== undefined ||
      lastReportedDate !== undefined
        ? {
            degraded: false,
            ...(marketCap !== undefined ? { marketCap } : {}),
            ...(sector !== undefined ? { sector } : {}),
            ...(industry !== undefined ? { industry } : {}),
            ...(nextEarningsDate !== undefined ? { nextEarningsDate } : {}),
            ...(lastReportedDate !== undefined ? { lastReportedDate } : {}),
          }
        : { degraded: true, reason: 'NO_PROFILE_DATA' };

    return { quote, profile };
  }

  /**
   * Resolve the soonest upcoming fiscal period-end from an earnings-consensus
   * bundle. Returns a YYYY-MM-DD string or undefined. The date is a period-end
   * (quarter/FY), not the literal earnings-call date — the UI labels it as
   * "下一财报期截止" accordingly. Quarters are preferred over FY so the nearer
   * milestone wins when both are forecast.
   */
  private pickNextEarningsDate(
    bundle: { estimates?: Array<{ periodEndOn?: string; periodType?: string }> } | null | undefined,
  ): string | undefined {
    const today = new Date().toISOString().slice(0, 10);
    const upcoming = (bundle?.estimates ?? [])
      .filter((e) => typeof e.periodEndOn === 'string' && e.periodEndOn >= today)
      .sort((a, b) => {
        // Quarter periods sort before FY on equal date so the nearer cadence
        // is surfaced first.
        const periodRank = (p?: string) => (p === 'QUARTER' ? 0 : 1);
        return (
          a.periodEndOn!.localeCompare(b.periodEndOn!) ||
          periodRank(a.periodType) - periodRank(b.periodType)
        );
      });
    return upcoming[0]?.periodEndOn?.slice(0, 10);
  }
}

function normalizeDetailSearchSymbol(symbol: string, market: string): string {
  const normalized = symbol.trim().toUpperCase();
  if (market === 'HK') return normalized.replace(/\.HK$/, '');
  if (market === 'CN') return normalized.replace(/\.(SS|SZ)$/, '');
  return normalized;
}

/**
 * Map the analysis Quote.marketStatus enum to the Yahoo-style state string the
 * web header understands. Returns null when the source gave no usable state
 * (absent or UNKNOWN) so the caller can fall back to the exchange-clock check.
 */
function marketStatusToLabel(
  status: 'OPEN' | 'CLOSED' | 'PRE_MARKET' | 'AFTER_HOURS' | 'UNKNOWN' | undefined,
): string | null {
  switch (status) {
    case 'OPEN':
      return 'REGULAR';
    case 'PRE_MARKET':
      return 'PRE';
    case 'AFTER_HOURS':
      return 'POST';
    case 'CLOSED':
      return 'CLOSED';
    default:
      return null; // UNKNOWN / undefined → let the caller compute
  }
}
