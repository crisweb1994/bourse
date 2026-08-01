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

import type {
  ConnectorRunContext,
  DataFreshness,
  FilingSummary,
  FinancialsBundle,
  CompanyProfile,
  CorporateAction,
  Capability,
  DataSet,
  EarningsConsensusBundle,
  MacroSnapshot,
  MarketEvent,
  OwnershipObservation,
  PriceBar,
  Quote,
  ResearchCitation,
  ResearchResult,
  ResearchWarning,
  QualityTier,
  QuoteDelay,
} from '@bourse/market-data';

/**
 * Connector envelopes preserve provenance at the Snapshot boundary. Test
 * doubles may still return a bare value, but production ports return this
 * shape so citations, freshness and warnings survive into EvidencePack.
 */
export interface SnapshotFetcherEnvelope<T> {
  data: T;
  citations: readonly ResearchCitation[];
  freshness?: readonly DataFreshness[];
  warnings?: readonly ResearchWarning[];
  trace?: unknown;
  cost?: unknown;
  schemaVersion?: string;
}
export type SnapshotFetcherOutput<T> = T | SnapshotFetcherEnvelope<T | null> | null;

// ----------------------------------------------------------------------------
// Per-connector function shapes (caller-controlled, framework-free)
// ----------------------------------------------------------------------------

export interface QuoteFetcher {
  (symbol: string, ctx?: ConnectorRunContext): Promise<SnapshotFetcherOutput<Quote>>;
}
export interface HistoryFetcher {
  (
    symbol: string,
    from: string,
    to: string,
    ctx?: ConnectorRunContext,
  ): Promise<SnapshotFetcherOutput<PriceBar[]>>;
}
export interface ProfileFetcher {
  (symbol: string, ctx?: ConnectorRunContext): Promise<SnapshotFetcherOutput<CompanyProfile>>;
}
export interface FinancialsFetcher {
  (symbol: string, ctx?: ConnectorRunContext): Promise<SnapshotFetcherOutput<FinancialsBundle>>;
}
export interface FilingsFetcher {
  (
    symbol: string,
    limit: number,
    ctx?: ConnectorRunContext,
  ): Promise<SnapshotFetcherOutput<FilingSummary[]>>;
}
/** Generic extra fact fetcher — returns whatever the connector emits. */
export interface ExtraFetcher<T> {
  (symbol: string, ctx?: ConnectorRunContext): Promise<SnapshotFetcherOutput<T>>;
}

// ----------------------------------------------------------------------------
// Per-market config record
// ----------------------------------------------------------------------------

export type Market = 'US' | 'CN' | 'HK';

export interface DataRequirement {
  key: string;
  capability: Capability;
  dataSet?: DataSet;
  seriesCode?: string;
  required: boolean;
  maxAgeMs?: number;
  minQualityTier?: QualityTier;
  acceptedDelays?: QuoteDelay[];
}

const CORE_REQUIREMENTS: readonly DataRequirement[] = [
  { key: 'quote', capability: 'quote', required: true, maxAgeMs: 60_000 },
  { key: 'history', capability: 'history', required: true },
  { key: 'profile', capability: 'profile', required: false },
  { key: 'financials', capability: 'financials', required: true, minQualityTier: 'B' },
  { key: 'filings', capability: 'filings', required: true, minQualityTier: 'B' },
  { key: 'macro', capability: 'macro', dataSet: 'macro-series', required: false },
];

export const STANDARD_RESEARCH_REQUIREMENTS: Record<Market, readonly DataRequirement[]> = {
  US: CORE_REQUIREMENTS,
  CN: [...CORE_REQUIREMENTS.filter((item) => item.key !== 'macro'),
    { key: 'macro.cpi', capability: 'macro', dataSet: 'macro-series', seriesCode: 'CN.CPI.YOY', required: false },
    { key: 'macro.pmi', capability: 'macro', dataSet: 'macro-series', seriesCode: 'CN.PMI.MANUFACTURING', required: false },
    { key: 'macro.industrialOutput', capability: 'macro', dataSet: 'macro-series', seriesCode: 'CN.INDUSTRIAL_OUTPUT.YOY', required: false },
    { key: 'macro.retailSales', capability: 'macro', dataSet: 'macro-series', seriesCode: 'CN.RETAIL_SALES.YOY', required: false },
    { key: 'macro.fixedAssetInvestment', capability: 'macro', dataSet: 'macro-series', seriesCode: 'CN.FIXED_ASSET_INVESTMENT.YOY', required: false },
    { key: 'dividends', capability: 'corporate-actions', dataSet: 'dividend', required: false },
    { key: 'buybacks', capability: 'corporate-actions', dataSet: 'buyback', required: false },
    { key: 'stockConnect', capability: 'ownership', dataSet: 'stock-connect', required: false },
    { key: 'shareholders', capability: 'ownership', dataSet: 'shareholder-count', required: false },
    { key: 'earningsGuidance', capability: 'market-events', dataSet: 'earnings-guidance', required: false },
  ],
  HK: [...CORE_REQUIREMENTS,
    { key: 'dividends', capability: 'corporate-actions', dataSet: 'dividend', required: false },
    { key: 'buybacks', capability: 'corporate-actions', dataSet: 'buyback', required: false },
    { key: 'shortPosition', capability: 'ownership', dataSet: 'short-position', required: false },
    { key: 'earningsGuidance', capability: 'market-events', dataSet: 'earnings-guidance', required: false },
    { key: 'suspensions', capability: 'market-events', dataSet: 'suspension', required: false },
    { key: 'regulatoryEvents', capability: 'market-events', dataSet: 'regulatory-event', required: false },
  ],
};

export interface MarketConfig {
  market: Market;
  /** Currency for prices / market cap (instrument's local currency). */
  currency: 'USD' | 'CNY' | 'HKD';
  requirements?: readonly DataRequirement[];

  // Core fetchers (every market has at least quote)
  quote: QuoteFetcher;
  history?: HistoryFetcher;
  profile?: ProfileFetcher;
  financials?: FinancialsFetcher;
  filings?: FilingsFetcher;

  // Market-specific extras
  consensusEps?: ExtraFetcher<EarningsConsensusBundle>;
  northboundFlow?: ExtraFetcher<OwnershipObservation[]>;
  lhb?: ExtraFetcher<MarketEvent[]>;
  unlockCalendar?: ExtraFetcher<MarketEvent[]>;
  shareholders?: ExtraFetcher<OwnershipObservation[]>;
  corporateActions?: ExtraFetcher<CorporateAction[]>;
  ownership?: ExtraFetcher<OwnershipObservation[]>;
  marketEvents?: ExtraFetcher<MarketEvent[]>;

  // Shared
  webSearch?: ExtraFetcher<unknown>;
  macro?: ExtraFetcher<MacroSnapshot>;
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
 * Adapter helper: preserve a ResearchPort envelope for Snapshot. Flattening
 * it here would discard citations/freshness and makes a research result
 * impossible to audit later.
 *
 *   quote: portToFetcher((s, ctx) => yahoo.getQuote({ instrumentId: s }, ctx))
 */
export function portToFetcher<T>(
  call: (symbol: string, ctx?: ConnectorRunContext) => Promise<ResearchResult<T>>,
): (symbol: string, ctx?: ConnectorRunContext) => Promise<SnapshotFetcherEnvelope<T>> {
  return (symbol, ctx) => call(symbol, ctx);
}
