/**
 * plan-v2 Wave 2 — per-market connector configuration.
 *
 * Replaces:
 *   - packages/planning/src/snapshot/policies/*
 *   - packages/research-core capability matrix routing
 *
 * Shape: a static `Record<Market, MarketConfig>` listing the
 * connector callables for each fact key. Caller (snapshot/fetch.ts)
 * iterates entries and runs them in parallel. Optional connectors are
 * spread-only — fact stays `undefined` when no source is configured.
 *
 * Wave 2 keeps the value `null` until Wave 2.3 wires real ports from
 * @bourse/analysis; this file is the dependency-injection
 * surface that lets callers swap test doubles in / out.
 */

import type { ConnectorRunContext } from '../connectors/types';
import type { FilingSummary } from '../ports/filings';
import type { FinancialsBundle } from '../ports/financials';
import type { PriceBar, Quote } from '../ports/finance';
import type { ResearchResult } from '../contracts/result';

// ----------------------------------------------------------------------------
// Per-connector function shapes (caller-controlled, framework-free)
// ----------------------------------------------------------------------------

export interface QuoteFetcher {
  (symbol: string, ctx?: ConnectorRunContext): Promise<Quote | null>;
}
export interface HistoryFetcher {
  (
    symbol: string,
    from: string,
    to: string,
    ctx?: ConnectorRunContext,
  ): Promise<PriceBar[] | null>;
}
export interface ProfileFetcher {
  (symbol: string, ctx?: ConnectorRunContext): Promise<Record<string, unknown> | null>;
}
export interface FinancialsFetcher {
  (symbol: string, ctx?: ConnectorRunContext): Promise<FinancialsBundle | null>;
}
export interface FilingsFetcher {
  (
    symbol: string,
    limit: number,
    ctx?: ConnectorRunContext,
  ): Promise<FilingSummary[] | null>;
}
/** Generic extra fact fetcher — returns whatever the connector emits. */
export interface ExtraFetcher<T> {
  (symbol: string, ctx?: ConnectorRunContext): Promise<T | null>;
}

// ----------------------------------------------------------------------------
// Per-market config record
// ----------------------------------------------------------------------------

export type Market = 'US' | 'CN' | 'HK';

export interface MarketConfig {
  market: Market;
  /** Currency for prices / market cap (instrument's local currency). */
  currency: 'USD' | 'CNY' | 'HKD';

  // Core fetchers (every market has at least quote)
  quote: QuoteFetcher;
  history?: HistoryFetcher;
  profile?: ProfileFetcher;
  financials?: FinancialsFetcher;
  filings?: FilingsFetcher;

  // Market-specific extras
  consensusEps?: ExtraFetcher<unknown>;
  northboundFlow?: ExtraFetcher<unknown>;
  lhb?: ExtraFetcher<unknown>;
  unlockCalendar?: ExtraFetcher<unknown>;
  shareholders?: ExtraFetcher<unknown>;

  // Shared
  webSearch?: ExtraFetcher<unknown>;
  macro?: ExtraFetcher<unknown>;
}

export type MarketConfigMap = Record<Market, MarketConfig>;

// ----------------------------------------------------------------------------
// Default config — empty quote stub so unit tests can wire selectively
// without instantiating real ports. Caller (apps/api) overrides per market.
// ----------------------------------------------------------------------------

/**
 * Build a MarketConfig piecemeal — useful in tests + apps/api wiring.
 * `quote` is mandatory; the rest are spread-in optionals.
 */
export function defineMarketConfig(
  market: Market,
  currency: 'USD' | 'CNY' | 'HKD',
  fetchers: Omit<MarketConfig, 'market' | 'currency'>,
): MarketConfig {
  return { market, currency, ...fetchers };
}

/**
 * Adapter helper: turn a ResearchPort-style result (envelope with
 * data/warnings) into the bare `T | null` callable shape this config
 * expects. Use when wiring real ports from research-core, e.g.:
 *
 *   quote: portToFetcher((s, ctx) => yahoo.getQuote({ instrumentId: s }, ctx))
 */
export function portToFetcher<T>(
  call: (symbol: string, ctx?: ConnectorRunContext) => Promise<ResearchResult<T>>,
): (symbol: string, ctx?: ConnectorRunContext) => Promise<T | null> {
  return async (symbol, ctx) => {
    const env = await call(symbol, ctx);
    return env?.data ?? null;
  };
}
