export type InstrumentSearchMarket = 'US' | 'HK' | 'CN' | 'JP' | 'UK' | string;

export interface InstrumentSearchResult {
  symbol: string;
  name: string;
  market: InstrumentSearchMarket;
  exchange: string;
  currency: string;
  yahooSymbol: string;
}

export interface InstrumentSearchPort {
  search(query: string, signal?: AbortSignal): Promise<InstrumentSearchResult[]>;
}
