import type { MarketSession } from '../contracts/calendar';
import type { SourceResult } from '../contracts/source-result';
import type { MarketCode } from '../contracts/instrument';
import type { MarketCalendarPort } from '../ports/market-calendar';
import type { SourceRequestContext } from '../ports/request-context';

const RULES: Record<MarketCode, { timezone: string; open: number; close: number; pre?: number; after?: number }> = {
  US: { timezone: 'America/New_York', open: 9.5, close: 16, pre: 4, after: 20 },
  HK: { timezone: 'Asia/Hong_Kong', open: 9.5, close: 16 },
  CN: { timezone: 'Asia/Shanghai', open: 9.5, close: 15 },
  JP: { timezone: 'Asia/Tokyo', open: 9, close: 15 },
  UK: { timezone: 'Europe/London', open: 8, close: 16.5 },
};

/** Weekend-aware fallback. Exchange holiday calendars can replace this port later. */
export function createRuleBasedMarketCalendarPort(): MarketCalendarPort {
  return {
    async getMarketSession(input, ctx): Promise<SourceResult<MarketSession>> {
      const date = input.at ? new Date(input.at) : ctx.now();
      if (Number.isNaN(date.getTime())) {
        return failed('INVALID_PAYLOAD', `Invalid market session timestamp: ${input.at}`);
      }
      const rule = RULES[input.market];
      const local = formatInTimezone(date, rule.timezone);
      const isWeekend = local.weekday === 'Sat' || local.weekday === 'Sun';
      const state = isWeekend ? 'HOLIDAY' : stateFor(local.hour + local.minute / 60, rule);
      return {
        status: 'ok',
        data: { market: input.market, asOf: date.toISOString(), state, timezone: rule.timezone, tradingDay: local.day },
        sourceId: 'market-calendar-rules',
        citations: [],
        freshness: [{ provider: 'market-calendar-rules', asOf: date.toISOString(), retrievedAt: ctx.now().toISOString(), stale: false }],
        warnings: isWeekend ? [{ code: 'MARKET_CLOSED', message: `${input.market} is closed for the weekend.`, provider: 'market-calendar-rules' }] : [],
      };
    },
  };
}

function stateFor(hour: number, rule: { open: number; close: number; pre?: number; after?: number }): MarketSession['state'] {
  if (hour >= rule.open && hour < rule.close) return 'OPEN';
  if (rule.pre !== undefined && hour >= rule.pre && hour < rule.open) return 'PRE_MARKET';
  if (rule.after !== undefined && hour >= rule.close && hour < rule.after) return 'AFTER_HOURS';
  return 'CLOSED';
}

function formatInTimezone(date: Date, timezone: string): { weekday: string; day: string; hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? '';
  return { weekday: get('weekday'), day: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')), minute: Number(get('minute')) };
}

function failed(code: 'INVALID_PAYLOAD', message: string): SourceResult<MarketSession> {
  return { status: 'failed', data: null, sourceId: 'market-calendar-rules', citations: [], freshness: [], warnings: [{ code: 'SOURCE_UNAVAILABLE', message, provider: 'market-calendar-rules' }], error: { code, message } };
}
