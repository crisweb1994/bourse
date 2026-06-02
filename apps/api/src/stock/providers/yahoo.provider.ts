import { Injectable, Logger } from '@nestjs/common';
import type { StockSearchResult } from '@bourse/shared-types';

interface YahooQuote {
  symbol: string;
  shortname?: string;
  longname?: string;
  exchange: string;
  exchDisp?: string;
  typeDisp?: string;
  quoteType?: string;
}

const SEARCH_TIMEOUT_MS = 5000;
const US_EXCHANGES = new Set(['NMS', 'NYQ', 'NGM', 'NAS', 'PCX', 'BTS']);
const CURRENCY_BY_MARKET: Record<string, string> = {
  US: 'USD',
  HK: 'HKD',
  CN: 'CNY',
  JP: 'JPY',
  UK: 'GBP',
};
// EU exchanges Yahoo reports — used only when symbol has no recognizable
// suffix (no .L/.T/.HK/etc) and is in fact European.
const CURRENCY_BY_EXCHANGE: Record<string, string> = {
  PAR: 'EUR', GER: 'EUR', AMS: 'EUR', MIL: 'EUR', MCE: 'EUR', LIS: 'EUR',
};

@Injectable()
export class YahooProvider {
  private readonly logger = new Logger(YahooProvider.name);

  async search(query: string): Promise<StockSearchResult[]> {
    const url = `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=10&newsCount=0&listsCount=0&enableFuzzyQuery=false&quotesQueryId=tss_match_phrase_query`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);

    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        signal: controller.signal,
      });

      if (!res.ok) {
        this.logger.warn(`Yahoo search failed: HTTP ${res.status} for q="${query}"`);
        return [];
      }

      const data = (await res.json()) as { quotes?: YahooQuote[] };
      const quotes = data.quotes ?? [];

      return quotes
        .filter((q) => q.quoteType === 'EQUITY' || q.quoteType === 'ETF')
        .map((q) => {
          const market = this.resolveMarket(q.exchange, q.symbol);
          return {
            symbol: q.symbol.includes('.') ? q.symbol.split('.')[0] : q.symbol,
            name: q.longname || q.shortname || q.symbol,
            market,
            exchange: q.exchDisp || q.exchange,
            currency:
              CURRENCY_BY_MARKET[market] ??
              CURRENCY_BY_EXCHANGE[q.exchange] ??
              'USD',
            yahooSymbol: q.symbol,
          };
        });
    } catch (err) {
      this.logger.warn(`Yahoo search error for q="${query}": ${(err as Error).message}`);
      return [];
    } finally {
      clearTimeout(timeout);
    }
  }

  private resolveMarket(exchange: string, symbol: string): string {
    if (symbol.endsWith('.HK')) return 'HK';
    if (symbol.endsWith('.SS') || symbol.endsWith('.SZ')) return 'CN';
    if (symbol.endsWith('.T')) return 'JP';
    if (symbol.endsWith('.L')) return 'UK';
    if (US_EXCHANGES.has(exchange)) return 'US';
    return exchange;
  }
}
