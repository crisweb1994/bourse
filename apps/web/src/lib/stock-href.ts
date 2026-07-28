/**
 * Canonical /stock/:symbol link building. Every list (home, history,
 * watchlist) routes by `yahooSymbol || symbol` and carries the
 * stockId/market/name query the page needs to resolve + render without a
 * second lookup — centralized here so those callers don't each re-derive it.
 */

interface StockRouteInfo {
  id?: string | null;
  symbol: string;
  yahooSymbol?: string | null;
  market: string;
  name: string;
}

/** The URL path segment a stock routes under (yahoo-suffixed when available). */
export function routeSymbol(stock: {
  symbol: string;
  yahooSymbol?: string | null;
}): string {
  return encodeURIComponent(stock.yahooSymbol || stock.symbol);
}

export function stockHref(
  stock: StockRouteInfo,
  opts?: { analysisId?: string },
): string {
  const params = new URLSearchParams();
  if (stock.id) params.set('stockId', stock.id);
  params.set('market', stock.market);
  params.set('name', stock.name);
  if (opts?.analysisId) params.set('analysisId', opts.analysisId);
  return `/stock/${routeSymbol(stock)}?${params.toString()}`;
}
