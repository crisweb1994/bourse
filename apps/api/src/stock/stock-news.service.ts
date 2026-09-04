import { Inject, Injectable } from '@nestjs/common';
import { isMarket } from '@bourse/shared-types';
import {
  buildAdapterFromEnv,
  WebSearchExecutor,
  type WebSearchAdapter,
} from '@bourse/analysis';
import type { ResearchMarketDataClient, FilingSummary } from '@bourse/market-data';
import { MARKET_DATA_CLIENT } from '../connectors/connectors.module';
import { TtlLruCache } from './search-cache';

const NEWS_CACHE_MAX = 100;
const NEWS_CACHE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_LIMIT = 8;
const FILINGS_FETCH = 8;
const NEWS_FETCH = 8;
const NEWS_FRESHNESS_DAYS = 30;

export interface StockNewsItem {
  title: string;
  url: string;
  /** Filing provider ('SEC EDGAR' | 'HKEX' | 'cninfo') or web-search adapter id. */
  source: string;
  /** ISO datetime when available; null when the source has no machine date. */
  publishedAt: string | null;
  /** Filing form type ('8-K' | 'annual results' | …); undefined for news. */
  formType?: string;
  kind: 'filing' | 'news';
}

export interface StockNewsResponse {
  items: StockNewsItem[];
  /** Mirrors the per-field degradation pattern used by quote/profile. */
  degraded?: { reason: string };
}

/**
 * Recent-announcements feed for the stock header. Filings (regulator-grade:
 * SEC EDGAR 8-K / HKEX disclosures / cninfo 公告) are the primary, free, fast
 * source; a long-lived WebSearchExecutor adds non-filing news (analyst notes,
 * press wires) as a best-effort, cached, async enrichment. When no web-search
 * provider is configured the feed degrades gracefully to filings-only.
 */
@Injectable()
export class StockNewsService {
  private readonly cache = new TtlLruCache<string, StockNewsResponse>(
    NEWS_CACHE_MAX,
    NEWS_CACHE_TTL_MS,
  );
  private readonly executor: WebSearchExecutor | null;

  constructor(
    @Inject(MARKET_DATA_CLIENT) private readonly marketData: ResearchMarketDataClient,
  ) {
    // Build once at construction time so the in-executor LRU cache persists
    // across requests (100 users viewing AAPL → one upstream call per 5min).
    // Absence of WEB_SEARCH_PROVIDER is a normal state → filings-only.
    const built = buildAdapterFromEnv();
    this.executor = built ? this.buildExecutor(built.adapter, built.config.cacheTtlMs) : null;
  }

  private buildExecutor(
    adapter: WebSearchAdapter,
    cacheTtlMs: number,
  ): WebSearchExecutor {
    return new WebSearchExecutor({
      adapter,
      timeoutMs: 12_000,
      maxSearchesPerRun: 50,
      cacheTtlMs,
    });
  }

  async getNews(
    symbol: string,
    market: string,
    limit: number = DEFAULT_LIMIT,
  ): Promise<StockNewsResponse> {
    const m = (market ?? '').trim().toUpperCase();
    const s = (symbol ?? '').trim().toUpperCase();
    if (!s || !isMarket(m)) {
      return { items: [], degraded: { reason: 'UNSUPPORTED_MARKET' } };
    }

    const cacheKey = `${m}:${s}:${limit}`;
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    const instrumentId = `${m}:${s}`;
    // US: 8-K current reports surface material events; HK/CN take general
    // announcements (results, buybacks, monthly returns).
    const forms = m === 'US' ? ['8-K'] : undefined;

    // Filings (primary) and web-search (enrichment) run in parallel; each is
    // shielded so a single outage never voids the feed.
    const [filingsSettled, newsSettled] = await Promise.allSettled([
      this.marketData.listFilings({ instrumentId, forms, limit: FILINGS_FETCH }),
      this.fetchWebSearchNews(s, m),
    ]);

    const filings =
      filingsSettled.status === 'fulfilled' ? (filingsSettled.value?.data ?? []) : [];
    const news =
      newsSettled.status === 'fulfilled' ? newsSettled.value : [];

    const items = mergeAndRank(
      [...filings.map(toNewsItem), ...news],
      limit,
    );

    const response: StockNewsResponse =
      items.length > 0
        ? { items }
        : { items, degraded: { reason: 'NO_ANNOUNCEMENTS' } };

    // Only cache non-empty results — never pin a transient outage.
    if (items.length > 0) this.cache.set(cacheKey, response);
    return response;
  }

  private async fetchWebSearchNews(
    symbol: string,
    market: string,
  ): Promise<StockNewsItem[]> {
    if (!this.executor) return [];
    try {
      const out = await this.executor.execute({
        query: `${symbol} ${market} stock latest news announcement`,
        freshnessDays: NEWS_FRESHNESS_DAYS,
        count: NEWS_FETCH,
      });
      if (out.error) return [];
      return (out.output.results.items ?? []).map((item) => ({
        title: item.title,
        url: item.url,
        source: item.source ?? this.executor!.providerId,
        publishedAt: item.publishedAt ?? null,
        kind: 'news' as const,
      }));
    } catch {
      return [];
    }
  }
}

function toNewsItem(f: FilingSummary): StockNewsItem {
  return {
    title: f.title?.trim() || `${f.formType} filing`,
    url: f.filingUrl,
    source: f.provider,
    publishedAt: normalizeDate(f.filingDate),
    formType: f.formType,
    kind: 'filing',
  };
}

/** Merge filings + news, dedupe by URL, sort dated-first then undated. */
function mergeAndRank(items: StockNewsItem[], limit: number): StockNewsItem[] {
  const seen = new Set<string>();
  const deduped: StockNewsItem[] = [];
  for (const item of items) {
    if (seen.has(item.url)) continue;
    seen.add(item.url);
    deduped.push(item);
  }
  deduped.sort((a, b) => {
    if (a.publishedAt && b.publishedAt) return b.publishedAt.localeCompare(a.publishedAt);
    if (a.publishedAt) return -1;
    if (b.publishedAt) return 1;
    return 0;
  });
  return deduped.slice(0, limit);
}

/** Coerce a filing date (may be a full ISO or a bare YYYY-MM-DD) to ISO/null. */
function normalizeDate(value: string | undefined): string | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}
