import { Injectable, Logger } from '@nestjs/common';
import type { StockSearchResult } from '@bourse/shared-types';

interface EastMoneyItem {
  Code: string;
  Name: string;
  MktNum: string;
  SecurityType: string;
  SecurityTypeName: string;
}

interface EastMoneyResponse {
  QuotationCodeTable?: { Data?: EastMoneyItem[] };
}

const SEARCH_TIMEOUT_MS = 5000;

// MktNum → market profile. Anything not in this map is filtered out.
const MARKET_BY_MKTNUM: Record<
  string,
  { market: string; exchange: string; currency: string; yahooSuffix: string }
> = {
  '0':   { market: 'CN', exchange: 'SZSE',   currency: 'CNY', yahooSuffix: '.SZ' },
  '1':   { market: 'CN', exchange: 'SSE',    currency: 'CNY', yahooSuffix: '.SS' },
  '116': { market: 'HK', exchange: 'HKEX',   currency: 'HKD', yahooSuffix: '.HK' },
  '105': { market: 'US', exchange: 'NASDAQ', currency: 'USD', yahooSuffix: '' },
  '106': { market: 'US', exchange: 'NYSE',   currency: 'USD', yahooSuffix: '' },
  '107': { market: 'US', exchange: 'AMEX',   currency: 'USD', yahooSuffix: '' },
};

// SecurityType numeric codes to keep. East Money mixes bonds, futures, indexes
// in the same response — filter those out aggressively.
const KEEP_SECURITY_TYPES = new Set([
  '1',  // 沪A 股票
  '2',  // 深A 股票
  '6',  // 港股普通股
  '19', // 港股
  '20', // 美股普通股
]);

// HK warrants and CBBCs share SecurityType=6 with regular HK stocks but are
// identifiable by name keywords issuers use for derivatives.
const HK_DERIVATIVE_NAME_PATTERN = /购|沽|牛证|熊证/;

@Injectable()
export class EastMoneyProvider {
  private readonly logger = new Logger(EastMoneyProvider.name);

  async search(query: string): Promise<StockSearchResult[]> {
    const url = `https://searchapi.eastmoney.com/api/suggest/get?input=${encodeURIComponent(query)}&type=14&count=10`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);

    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        signal: controller.signal,
      });

      if (!res.ok) {
        this.logger.warn(`EastMoney search failed: HTTP ${res.status} for q="${query}"`);
        return [];
      }

      const data = (await res.json()) as EastMoneyResponse;
      const items = data.QuotationCodeTable?.Data ?? [];

      return items
        .filter((it) => {
          if (!MARKET_BY_MKTNUM[it.MktNum]) return false;
          if (!KEEP_SECURITY_TYPES.has(it.SecurityType)) return false;
          if (it.MktNum === '116' && HK_DERIVATIVE_NAME_PATTERN.test(it.Name)) {
            return false;
          }
          return true;
        })
        .map((it) => this.toResult(it));
    } catch (err) {
      this.logger.warn(`EastMoney search error for q="${query}": ${(err as Error).message}`);
      return [];
    } finally {
      clearTimeout(timeout);
    }
  }

  private toResult(item: EastMoneyItem): StockSearchResult {
    const profile = MARKET_BY_MKTNUM[item.MktNum];
    const symbol = this.normalizeSymbol(item.Code, profile.market);
    const yahooSymbol = `${symbol}${profile.yahooSuffix}`;

    return {
      symbol,
      name: item.Name,
      market: profile.market,
      exchange: profile.exchange,
      currency: profile.currency,
      yahooSymbol,
    };
  }

  // East Money returns HK codes as 5-digit (e.g. "00700", "01772"). Yahoo wants
  // the form without the leading zero ("0700.HK", "1772.HK"). For 5-char codes
  // starting with 0 we strip exactly one leading zero. A/US codes pass through.
  private normalizeSymbol(code: string, market: string): string {
    if (market === 'HK' && code.length === 5 && code.startsWith('0')) {
      return code.slice(1);
    }
    return code;
  }
}
