import type { MarketCode } from '../contracts/instrument';

export type StaticMarketHolidays = Partial<Record<MarketCode, readonly string[]>>;

/**
 * Exchange closure dates used by the process-local fallback calendar.
 * Keep this deliberately data-only and year-bounded so it can be reviewed and
 * replaced by an official calendar plugin without changing routing code.
 */
export const STATIC_MARKET_HOLIDAYS_2026: StaticMarketHolidays = {
  US: [
    '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03',
    '2026-05-25', '2026-06-19', '2026-07-03', '2026-09-07',
    '2026-11-26', '2026-12-25',
  ],
  HK: [
    '2026-01-01', '2026-02-17', '2026-02-18', '2026-02-19',
    '2026-04-03', '2026-04-06', '2026-04-07', '2026-05-01',
    '2026-05-25', '2026-06-19', '2026-07-01', '2026-10-01',
    '2026-10-19', '2026-12-25', '2026-12-28',
  ],
  CN: [
    '2026-01-01', '2026-01-02', '2026-02-16', '2026-02-17',
    '2026-02-18', '2026-02-19', '2026-02-20', '2026-02-23',
    '2026-04-06', '2026-05-01', '2026-05-04', '2026-05-05',
    '2026-06-19', '2026-09-25', '2026-10-01', '2026-10-02',
    '2026-10-05', '2026-10-06', '2026-10-07',
  ],
  JP: [
    '2026-01-01', '2026-01-02', '2026-01-12', '2026-02-11',
    '2026-02-23', '2026-03-20', '2026-04-29', '2026-05-04',
    '2026-05-05', '2026-05-06', '2026-07-20', '2026-08-11',
    '2026-09-21', '2026-09-22', '2026-09-23', '2026-10-12',
    '2026-11-03', '2026-11-23', '2026-12-31',
  ],
  UK: [
    '2026-01-01', '2026-04-03', '2026-04-06', '2026-05-04',
    '2026-05-25', '2026-08-31', '2026-12-25', '2026-12-28',
  ],
};

export function holidaySet(
  defaults: StaticMarketHolidays,
  additions: StaticMarketHolidays = {},
): ReadonlyMap<MarketCode, ReadonlySet<string>> {
  const markets: readonly MarketCode[] = ['US', 'CN', 'HK', 'JP', 'UK'];
  return new Map(markets.map((market) => [
    market,
    new Set([...(defaults[market] ?? []), ...(additions[market] ?? [])]),
  ]));
}
