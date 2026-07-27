import { Injectable, Logger } from '@nestjs/common';
import type { StockSearchResult } from '@bourse/shared-types';

const SEARCH_TIMEOUT_MS = 5_000;

const MARKET_PROFILES: Record<
  string,
  { market: string; exchange: string; currency: string; yahooSuffix: string }
> = {
  sh: { market: 'CN', exchange: 'SSE', currency: 'CNY', yahooSuffix: '.SS' },
  sz: { market: 'CN', exchange: 'SZSE', currency: 'CNY', yahooSuffix: '.SZ' },
  bj: { market: 'CN', exchange: 'BSE', currency: 'CNY', yahooSuffix: '.BJ' },
  hk: { market: 'HK', exchange: 'HKEX', currency: 'HKD', yahooSuffix: '.HK' },
  us: { market: 'US', exchange: 'US', currency: 'USD', yahooSuffix: '' },
};

const SUPPORTED_SECURITY_TYPES = new Set(['GP', 'GP-A', 'ETF']);

@Injectable()
export class TencentProvider {
  private readonly logger = new Logger(TencentProvider.name);

  async search(query: string): Promise<StockSearchResult[]> {
    const url = `https://smartbox.gtimg.cn/s3/?q=${encodeURIComponent(query)}&t=all`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        headers: {
          Accept: 'text/plain, */*',
          Referer: 'https://gu.qq.com/',
          'User-Agent': 'Mozilla/5.0',
        },
        signal: controller.signal,
      });
      if (!response.ok) {
        this.logger.warn(`Tencent search failed: HTTP ${response.status} for q="${query}"`);
        return [];
      }
      return parseTencentSearchResponse(await response.text());
    } catch (error) {
      this.logger.warn(
        `Tencent search error for q="${query}": ${error instanceof Error ? error.message : String(error)}`,
      );
      return [];
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function parseTencentSearchResponse(body: string): StockSearchResult[] {
  const assignment = body.trim().replace(/;$/, '');
  const equalsAt = assignment.indexOf('=');
  if (equalsAt < 0) return [];

  let payload: string;
  try {
    payload = JSON.parse(assignment.slice(equalsAt + 1)) as string;
  } catch {
    return [];
  }

  const seen = new Set<string>();
  const results: StockSearchResult[] = [];
  for (const rawEntry of payload.split('^')) {
    const [marketCode, providerSymbol, name, , securityType] = rawEntry.split('~');
    const profile = MARKET_PROFILES[marketCode?.toLowerCase()];
    if (!profile || !providerSymbol || !name) continue;
    if (!SUPPORTED_SECURITY_TYPES.has(securityType?.toUpperCase())) continue;

    const symbol = normalizeSymbol(marketCode, providerSymbol);
    if (!symbol) continue;
    const key = `${profile.market}:${symbol}`;
    if (seen.has(key)) continue;
    seen.add(key);

    results.push({
      symbol,
      name,
      market: profile.market,
      exchange:
        profile.market === 'US' ? resolveUsExchange(providerSymbol) : profile.exchange,
      currency: profile.currency,
      yahooSymbol: `${symbol}${profile.yahooSuffix}`,
    });
    if (results.length >= 10) break;
  }
  return results;
}

function normalizeSymbol(marketCode: string, providerSymbol: string): string {
  if (marketCode.toLowerCase() === 'us') {
    const suffixAt = providerSymbol.lastIndexOf('.');
    return (suffixAt > 0 ? providerSymbol.slice(0, suffixAt) : providerSymbol).toUpperCase();
  }
  if (marketCode.toLowerCase() === 'hk') {
    return providerSymbol.length === 5 && providerSymbol.startsWith('0')
      ? providerSymbol.slice(1)
      : providerSymbol;
  }
  return providerSymbol.toUpperCase();
}

function resolveUsExchange(providerSymbol: string): string {
  const suffix = providerSymbol.slice(providerSymbol.lastIndexOf('.') + 1).toLowerCase();
  if (suffix === 'oq' || suffix === 'o') return 'NASDAQ';
  if (suffix === 'n') return 'NYSE';
  if (suffix === 'a' || suffix === 'am') return 'AMEX';
  if (suffix === 'ps') return 'OTC';
  return 'US';
}
