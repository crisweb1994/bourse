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
  | 'market-calendar';

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

export interface CapabilitySpec {
  capability: Capability;
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
}

export interface SourceManifest {
  id: string;
  name: string;
  sourceType: 'official' | 'licensed-vendor' | 'broker' | 'public-api' | 'scrape' | 'search' | 'derived';
  requiresAuth: boolean;
  /** Default only. Capability-level redistribution is authoritative. */
  allowRedistribution: boolean;
  capabilities: readonly CapabilitySpec[];
  rateLimit: {
    requestsPerSecond?: number;
    concurrent: number;
  };
}
