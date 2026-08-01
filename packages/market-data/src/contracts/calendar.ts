import type { MarketCode } from './instrument';

export interface MarketSession {
  market: MarketCode;
  asOf: string;
  state: 'PRE_MARKET' | 'OPEN' | 'AFTER_HOURS' | 'CLOSED' | 'HOLIDAY' | 'UNKNOWN';
  timezone: string;
  tradingDay: string;
}
