/**
 * Shared CN A-share connector bits.
 *
 * `finance/cn.ts` and `filings/cn.ts` each had their own copies of the exchange
 * enum, browser headers, and `inferExchange`. The two `inferExchange` were
 * DIVERGENT (a latent bug — a symbol could classify differently for quote vs
 * filings). This module hoists ONE canonical version.
 */

/** Shanghai (SS) / Shenzhen (SZ) / Beijing (BJ) stock exchange. */
export type Exchange = 'SS' | 'SZ' | 'BJ';

/**
 * Browser-like headers shared by both CN connectors. Reconciled superset of
 * the two original copies: filings/cn.ts omitted the `Accept` header; it's
 * included here (the broader value finance/cn.ts used). Adding a more-permissive
 * `Accept` to the filings requests is inert — those upstreams already returned
 * JSON regardless, and cninfo's POST path further overrides `Accept` locally.
 */
export const CN_BROWSER_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.9,*/*;q=0.8',
};

/**
 * Infer the CN exchange from a 6-digit A-share code.
 *
 * Canonical version (superset of the two originals — finance/cn.ts's). On every
 * standard 6-digit code it agrees with the simpler filings version; they only
 * differed on partial/non-6-digit inputs the filings copy mis-handled, which
 * `parseInstrumentId` never produces for valid CN instruments.
 */
export function inferExchange(symbol: string): Exchange | null {
  if (/^6\d{5}$/.test(symbol) || /^688\d{3}$/.test(symbol)) return 'SS';
  if (/^(00|001|002|003|300|301)\d/.test(symbol) || /^0\d{5}$/.test(symbol) || /^3\d{5}$/.test(symbol)) {
    return 'SZ';
  }
  if (/^(43|83|87|88)\d{4}$/.test(symbol)) return 'BJ';
  return null;
}
