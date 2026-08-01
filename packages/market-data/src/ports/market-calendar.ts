import type { MarketSession } from '../contracts/calendar';
import type { MarketCode } from '../contracts/instrument';
import type { SourceResult } from '../contracts/source-result';
import type { SourceRequestContext } from './request-context';

export interface MarketCalendarPort {
  getMarketSession(
    input: { market: MarketCode; at?: string },
    ctx: SourceRequestContext,
  ): Promise<SourceResult<MarketSession>>;
  getPreviousTradingDay?(
    input: { market: MarketCode; before: string },
    ctx: SourceRequestContext,
  ): Promise<SourceResult<{ market: MarketCode; date: string }>>;
}
