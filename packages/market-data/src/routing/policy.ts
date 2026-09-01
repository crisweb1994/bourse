import type { Capability, DataSet, QuoteDelay } from '../contracts/source';
import type { MarketCode } from '../contracts/instrument';
import type { QualityTier } from '../contracts/research-citation';

export type RoutingStrategy = 'fallback' | 'merge' | 'official-first' | 'cross-check';

export interface RoutingPolicy {
  capability: Capability;
  market: MarketCode;
  dataSet?: DataSet;
  strategy: RoutingStrategy;
  preferredSources: readonly string[];
  disabledSources?: readonly string[];
  minQualityTier?: QualityTier;
  acceptedDelays?: readonly QuoteDelay[];
  maxAgeMs?: number;
  allowStaleIfError?: boolean;
  maxStaleMs?: number;
  /** Maximum time one candidate may consume before the router tries the next. */
  attemptTimeoutMs?: number;
  crossCheck?: {
    /** Dot-separated numeric fields on the canonical result, for example `price`. */
    fields: readonly string[];
    /** Maximum relative difference from the selected source before warning. */
    tolerance: number;
    minSources?: number;
  };
}

export class RoutingPolicies {
  constructor(private readonly policies: readonly RoutingPolicy[]) {}

  find(capability: Capability, market: MarketCode, dataSet?: DataSet): RoutingPolicy | undefined {
    const matching = this.policies.filter((policy) =>
      policy.capability === capability && policy.market === market,
    );
    if (dataSet) {
      return matching.find((policy) => policy.dataSet === dataSet) ??
        matching.find((policy) => policy.dataSet === undefined);
    }
    return matching.find((policy) => policy.dataSet === undefined);
  }

  hasCapability(capability: Capability): boolean {
    return this.policies.some((policy) => policy.capability === capability);
  }

  hasMarket(market: MarketCode): boolean {
    return this.policies.some((policy) => policy.market === market);
  }
}

export const DEFAULT_ROUTING_POLICIES: readonly RoutingPolicy[] = [
  { capability: 'quote', market: 'US', strategy: 'fallback', preferredSources: ['massive', 'twelve-data', 'alpha-vantage', 'eodhd', 'yahoo', 'nasdaq', 'sina'] },
  { capability: 'history', market: 'US', strategy: 'fallback', preferredSources: ['massive', 'twelve-data', 'alpha-vantage', 'eodhd', 'yahoo', 'nasdaq', 'sina'] },
  { capability: 'profile', market: 'US', strategy: 'fallback', preferredSources: ['massive', 'twelve-data', 'alpha-vantage', 'eodhd', 'yahoo', 'sec-edgar-profile'] },
  { capability: 'financials', market: 'US', strategy: 'official-first', preferredSources: ['sec-edgar-xbrl'] },
  { capability: 'filings', market: 'US', strategy: 'official-first', preferredSources: ['sec-edgar'] },
  { capability: 'filing-document', market: 'US', strategy: 'official-first', preferredSources: ['sec-edgar'] },
  { capability: 'earnings-consensus', market: 'US', strategy: 'fallback', preferredSources: ['yahoo'] },
  { capability: 'macro', market: 'US', strategy: 'official-first', preferredSources: ['official-macro'] },
  { capability: 'instrument-search', market: 'US', strategy: 'merge', preferredSources: ['yahoo-search', 'tencent-search', 'eastmoney-search'] },
  { capability: 'market-calendar', market: 'US', strategy: 'fallback', preferredSources: ['market-calendar-rules'] },
  { capability: 'quote', market: 'HK', strategy: 'fallback', preferredSources: ['twelve-data', 'eodhd', 'yahoo', 'tencent-hk'] },
  { capability: 'history', market: 'HK', strategy: 'fallback', preferredSources: ['twelve-data', 'eodhd', 'yahoo', 'tencent-hk'] },
  { capability: 'profile', market: 'HK', strategy: 'fallback', preferredSources: ['twelve-data', 'eodhd', 'yahoo', 'eastmoney-hk-profile'] },
  { capability: 'financials', market: 'HK', strategy: 'official-first', preferredSources: ['hkex-derived-financials', 'eastmoney-hk-financials'], attemptTimeoutMs: 2_500 },
  { capability: 'filings', market: 'HK', strategy: 'official-first', preferredSources: ['hkex'] },
  { capability: 'filing-document', market: 'HK', strategy: 'official-first', preferredSources: ['hkex'] },
  { capability: 'earnings-consensus', market: 'HK', strategy: 'fallback', preferredSources: ['yahoo'] },
  { capability: 'macro', market: 'HK', strategy: 'official-first', preferredSources: ['official-macro'] },
  { capability: 'instrument-search', market: 'HK', strategy: 'merge', preferredSources: ['yahoo-search', 'tencent-search', 'eastmoney-search'] },
  { capability: 'market-calendar', market: 'HK', strategy: 'fallback', preferredSources: ['market-calendar-rules'] },
  { capability: 'quote', market: 'CN', strategy: 'fallback', preferredSources: ['twelve-data', 'eodhd', 'cn-finance'] },
  { capability: 'history', market: 'CN', strategy: 'fallback', preferredSources: ['twelve-data', 'eodhd', 'cn-finance', 'tencent-cn-history'] },
  { capability: 'profile', market: 'CN', strategy: 'fallback', preferredSources: ['twelve-data', 'eodhd', 'cn-finance'] },
  { capability: 'financials', market: 'CN', strategy: 'official-first', preferredSources: ['eastmoney-financials'] },
  { capability: 'filings', market: 'CN', strategy: 'official-first', preferredSources: ['cn-filings'] },
  { capability: 'filing-document', market: 'CN', strategy: 'official-first', preferredSources: ['cn-filings'] },
  { capability: 'earnings-consensus', market: 'CN', strategy: 'fallback', preferredSources: ['cn-finance'] },
  { capability: 'macro', market: 'CN', strategy: 'official-first', preferredSources: ['official-macro', 'nbs-cn-macro'] },
  { capability: 'instrument-search', market: 'CN', strategy: 'merge', preferredSources: ['eastmoney-search', 'tencent-search', 'yahoo-search'] },
  { capability: 'market-calendar', market: 'CN', strategy: 'fallback', preferredSources: ['tushare-pro', 'market-calendar-rules'] },
  { capability: 'equity-screener', market: 'CN', strategy: 'fallback', preferredSources: ['eastmoney-cn-screener'], attemptTimeoutMs: 12_000 },
  { capability: 'corporate-actions', dataSet: 'adjustment-factor', market: 'CN', strategy: 'fallback', preferredSources: ['tushare-pro'] },
  { capability: 'corporate-actions', dataSet: 'dividend', market: 'CN', strategy: 'fallback', preferredSources: ['tushare-pro'] },
  { capability: 'corporate-actions', dataSet: 'buyback', market: 'CN', strategy: 'fallback', preferredSources: ['tushare-pro'] },
  { capability: 'ownership', dataSet: 'stock-connect', market: 'CN', strategy: 'fallback', preferredSources: ['tushare-pro', 'cn-public-ownership'] },
  { capability: 'ownership', dataSet: 'shareholder-count', market: 'CN', strategy: 'fallback', preferredSources: ['tushare-pro', 'cn-public-ownership'] },
  { capability: 'ownership', dataSet: 'margin', market: 'CN', strategy: 'fallback', preferredSources: ['tushare-pro'] },
  { capability: 'market-events', dataSet: 'lhb', market: 'CN', strategy: 'fallback', preferredSources: ['tushare-pro', 'cn-public-events'] },
  { capability: 'market-events', dataSet: 'unlock', market: 'CN', strategy: 'fallback', preferredSources: ['tushare-pro', 'cn-public-events'] },
  { capability: 'market-events', dataSet: 'earnings-guidance', market: 'CN', strategy: 'fallback', preferredSources: ['tushare-pro'] },
  { capability: 'market-events', dataSet: 'suspension', market: 'CN', strategy: 'fallback', preferredSources: ['tushare-pro'] },
  { capability: 'market-events', dataSet: 'price-limit', market: 'CN', strategy: 'fallback', preferredSources: ['tushare-pro'] },
  { capability: 'corporate-actions', market: 'HK', strategy: 'official-first', preferredSources: ['hkex-filings-derived-events'] },
  { capability: 'ownership', market: 'HK', strategy: 'official-first', preferredSources: ['sfc-short-position'] },
  { capability: 'ownership', dataSet: 'short-position', market: 'HK', strategy: 'official-first', preferredSources: ['sfc-short-position'] },
  { capability: 'market-events', dataSet: 'earnings-guidance', market: 'HK', strategy: 'official-first', preferredSources: ['hkex-filings-derived-events'] },
  { capability: 'market-events', dataSet: 'suspension', market: 'HK', strategy: 'official-first', preferredSources: ['hkex-filings-derived-events'] },
  { capability: 'market-events', dataSet: 'regulatory-event', market: 'HK', strategy: 'official-first', preferredSources: ['hkex-filings-derived-events'] },
  { capability: 'market-events', market: 'HK', strategy: 'official-first', preferredSources: ['hkex-filings-derived-events'] },
  { capability: 'market-calendar', market: 'JP', strategy: 'fallback', preferredSources: ['market-calendar-rules'] },
  { capability: 'market-calendar', market: 'UK', strategy: 'fallback', preferredSources: ['market-calendar-rules'] },
];
