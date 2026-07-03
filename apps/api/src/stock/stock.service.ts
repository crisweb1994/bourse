import { Inject, Injectable } from '@nestjs/common';
import { Market, type StockSearchResult } from '@bourse/shared-types';
import type { FinancePort } from '@bourse/analysis';
import { PrismaService } from '../prisma/prisma.service';
import { UpsertStockDto } from './stock.dto';
import { EastMoneyProvider } from './providers/eastmoney.provider';
import { YahooProvider } from './providers/yahoo.provider';
import {
  CN_FINANCE_PORT,
  YAHOO_FINANCE_PORT,
} from '../connectors/connectors.module';
import { resolveMarketState } from './market-hours';
import { TtlLruCache } from './search-cache';

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
    private eastMoney: EastMoneyProvider,
    private yahoo: YahooProvider,
    // plan-v2 §12.1 — quote/profile now come off the analysis FinancePort
    // connectors (US/HK: Yahoo v8 chart + crumb'd summaryDetail; CN:
    // Tencent/Eastmoney). The legacy YahooProvider.getQuote/getProfile path
    // hit Yahoo's now-401'd v7/v10 endpoints; YahooProvider is kept only for
    // its search() fallback.
    @Inject(YAHOO_FINANCE_PORT) private readonly yahooFinance: FinancePort,
    @Inject(CN_FINANCE_PORT) private readonly cnFinance: FinancePort,
  ) {}

  async search(query: string): Promise<StockSearchResult[]> {
    const q = query?.trim() ?? '';
    if (!q) return [];

    const cacheKey = q.toLowerCase();
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    // East Money first — supports Chinese, A-shares, HK, US.
    let results = await this.eastMoney.search(q);

    // Fall back to Yahoo when East Money returns nothing (e.g. JP/UK/EU
    // markets, or queries it doesn't recognize).
    if (results.length === 0) {
      results = await this.yahoo.search(q);
    }

    this.cache.set(cacheKey, results);
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
  async getDetail(symbol: string, market: string) {
    const stock = await this.findBySymbolAndMarket(symbol, market);
    if (!stock) {
      const candidates = await this.search(symbol);
      return { stock: null, quote: null, profile: null, candidates };
    }

    // Invariant #2 "fetch 一次": one getQuote drives both the quote and the
    // marketCap on the profile — the FinancePort bundles marketCap into the
    // Quote (Yahoo via summaryDetail, CN via Tencent).
    const { quote, profile } = await this.fetchQuoteAndProfile(stock);
    return { stock, quote, profile, candidates: [] as const };
  }

  private financePortFor(market: string): FinancePort | null {
    switch (market.trim().toUpperCase()) {
      case 'CN':
        return this.cnFinance;
      case 'US':
      case 'HK':
        return this.yahooFinance;
      default:
        return null;
    }
  }

  private async fetchQuoteAndProfile(stock: {
    symbol: string;
    market: string;
  }): Promise<{ quote: QuoteDto; profile: ProfileDto }> {
    const port = this.financePortFor(stock.market);
    if (!port) {
      const reason = 'UNSUPPORTED_MARKET';
      return {
        quote: { degraded: true, reason },
        profile: { degraded: true, reason },
      };
    }

    const market = stock.market.trim().toUpperCase();
    const instrumentId = `${market}:${stock.symbol}`;
    let env;
    try {
      env = await port.getQuote({ instrumentId });
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

    // Quote.changePct is unit-inconsistent across connectors (Yahoo returns a
    // percent, CN a decimal fraction — see ports/finance.ts + cn.ts). Derive
    // it ourselves from change + previous close so the web header always gets
    // a percent. previousClose falls back to (price − change).
    const change = q.change ?? 0;
    const prevClose = q.previousClose ?? q.price - change;
    const changePct = prevClose ? (change / prevClose) * 100 : 0;
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

    // Quote.marketCap units differ by source (see ports/finance.ts): CN
    // sources report 亿元, Yahoo reports raw currency units. The web
    // formatter assumes raw units, so normalize CN back to raw (× 1e8).
    const marketCap =
      typeof q.marketCap === 'number'
        ? market === 'CN'
          ? q.marketCap * 1e8
          : q.marketCap
        : undefined;
    const profile: ProfileDto =
      marketCap !== undefined
        ? { degraded: false, marketCap }
        : { degraded: true, reason: 'NO_PROFILE_DATA' };

    return { quote, profile };
  }
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
