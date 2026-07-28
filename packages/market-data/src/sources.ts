import type { MarketCode } from './contracts/instrument';

export type SupportedMarket = Extract<MarketCode, 'US' | 'CN' | 'HK'>;

export const SOURCE_PRIORITY = {
  US: {
    quote: ['twelve-data', 'alpha-vantage', 'eodhd', 'yahoo', 'nasdaq', 'sina'],
    history: ['twelve-data', 'alpha-vantage', 'eodhd', 'yahoo', 'nasdaq', 'sina'],
    profile: ['twelve-data', 'alpha-vantage', 'eodhd', 'yahoo', 'sec-edgar-profile'],
    financials: ['sec-edgar-xbrl'],
    filings: ['sec-edgar'],
    macro: ['world-bank', 'fred', 'us-treasury'],
    search: ['tavily'],
  },
  HK: {
    quote: ['twelve-data', 'eodhd', 'yahoo', 'tencent-hk'],
    history: ['twelve-data', 'eodhd', 'yahoo', 'tencent-hk'],
    profile: ['twelve-data', 'eodhd', 'yahoo', 'eastmoney-hk-profile'],
    financials: ['eastmoney-hk-financials'],
    filings: ['hkex'],
    macro: ['world-bank', 'hkma'],
    search: ['tavily'],
  },
  CN: {
    quote: ['twelve-data', 'eodhd', 'cn-finance'],
    history: ['twelve-data', 'eodhd', 'cn-finance', 'tencent-cn-history'],
    profile: ['twelve-data', 'eodhd', 'cn-finance'],
    financials: ['eastmoney-financials'],
    filings: ['cn-filings'],
    macro: ['world-bank'],
    search: ['tavily'],
  },
} as const satisfies Record<SupportedMarket, Record<string, readonly string[]>>;

export type MarketDataKind = keyof (typeof SOURCE_PRIORITY)['US'];

export function sourcePriority(
  market: SupportedMarket,
  kind: MarketDataKind,
): readonly string[] {
  return SOURCE_PRIORITY[market][kind];
}
