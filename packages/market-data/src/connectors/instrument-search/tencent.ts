import type {
  InstrumentSearchResult,
  ProviderInstrumentSearchPort as InstrumentSearchPort,
} from '../../ports/instrument-search';

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

export class TencentInstrumentSearchProvider implements InstrumentSearchPort {
  async search(query: string, outerSignal?: AbortSignal): Promise<InstrumentSearchResult[]> {
    const url = `https://smartbox.gtimg.cn/s3/?q=${encodeURIComponent(query)}&t=all`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
    const onOuterAbort = () => controller.abort(outerSignal?.reason);
    outerSignal?.addEventListener('abort', onOuterAbort, { once: true });

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
        return [];
      }
      return parseTencentSearchResponse(await response.text());
    } catch (error) {
      return [];
    } finally {
      clearTimeout(timeout);
      outerSignal?.removeEventListener('abort', onOuterAbort);
    }
  }
}

export function parseTencentSearchResponse(body: string): InstrumentSearchResult[] {
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
  const results: InstrumentSearchResult[] = [];
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
