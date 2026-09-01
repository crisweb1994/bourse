import type { MarketCode } from './instrument';
import type { QualityTier } from './research-citation';

export type Capability =
  | 'quote'
  | 'history'
  | 'profile'
  | 'financials'
  | 'filings'
  | 'filing-document'
  | 'earnings-consensus'
  | 'macro'
  | 'instrument-search'
  | 'market-calendar'
  | 'corporate-actions'
  | 'ownership'
  | 'market-events'
  | 'equity-screener';

export type DataSet =
  | 'dividend'
  | 'split'
  | 'rights-issue'
  | 'placement'
  | 'buyback'
  | 'adjustment-factor'
  | 'shareholder-count'
  | 'stock-connect'
  | 'short-position'
  | 'institutional-position'
  | 'insider-transaction'
  | 'margin'
  | 'earnings-calendar'
  | 'earnings-guidance'
  | 'unlock'
  | 'lhb'
  | 'suspension'
  | 'price-limit'
  | 'index-rebalance'
  | 'regulatory-event'
  | 'macro-series'
  | 'session';

export type SecurityType = 'stock' | 'etf' | 'index' | 'fund' | 'option';
export type QuoteDelay = 'realtime' | 'delayed' | 'eod';
export type CacheScope = 'public' | `credential:${string}`;
export type SourceAuthority =
  | 'regulator'
  | 'exchange'
  | 'official-derived'
  | 'licensed'
  | 'aggregated'
  | 'public-api'
  | 'scrape'
  | 'derived';
export type RedistributionPolicy =
  | 'public-cache-allowed'
  | 'credential-cache-only'
  | 'no-store';

export type SourceTransport =
  | 'official-api'
  | 'vendor-api'
  | 'official-html'
  | 'official-file'
  | 'scrape'
  | 'derived';

export interface SourceRateLimit {
  /** Backward-compatible shorthand for a one-second fixed window. */
  requestsPerSecond?: number;
  /** Generic fixed-window quota, used by providers with minute/day limits. */
  maxRequests?: number;
  windowMs?: number;
  concurrent?: number;
}

export interface CapabilitySpec {
  capability: Capability;
  /** Optional domain sub-capabilities, for example ownership/stock-connect. */
  dataSets?: readonly DataSet[];
  /** Canonical macro series implemented by this source. */
  seriesCodes?: readonly string[];
  markets: readonly MarketCode[];
  qualityTier: QualityTier;
  authority: SourceAuthority;
  ttlMs: number;
  redistribution: RedistributionPolicy;
  securityTypes?: readonly SecurityType[];
  intervals?: readonly ('1d' | '1h' | '5m' | '1m')[];
  delay?: QuoteDelay;
  allowStaleIfError?: boolean;
  maxStaleMs?: number;
  transport?: SourceTransport;
  /** Overrides the source-wide quota for this capability/data-set route. */
  rateLimit?: SourceRateLimit;
}

export interface SourceManifest {
  id: string;
  name: string;
  sourceType: 'official' | 'licensed-vendor' | 'broker' | 'public-api' | 'scrape' | 'search' | 'derived';
  requiresAuth: boolean;
  /** Default only. Capability-level redistribution is authoritative. */
  allowRedistribution: boolean;
  capabilities: readonly CapabilitySpec[];
  rateLimit: SourceRateLimit & { concurrent: number };
}
