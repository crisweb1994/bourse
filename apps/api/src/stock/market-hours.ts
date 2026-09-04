/**
 * Exchange-local calendar parts, computed in the EXCHANGE's own timezone via
 * `Intl` so the result is independent of the server's or the user's timezone
 * (DST-correct).
 *
 * KISS C6-9: the session-state side of this file moved to market-data's
 * rule-based calendar (getMarketSession — weekend AND static-holiday aware);
 * stock detail uses that. Only localParts remains here, consumed by
 * digest-windows for Daily Brief window resolution.
 */

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

export interface LocalParts {
  weekday: number; // 0=Sun .. 6=Sat
  minutes: number; // minutes from midnight
  ymd: string; // YYYY-MM-DD in exchange tz
}

/** Exchange-local calendar parts (weekday / minutes / ymd) via Intl, DST-correct.
 *  Exported for Daily Brief window logic (PRD DB.1) so DST stays collected here. */
export function localParts(tz: string, at: Date): LocalParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(at);
  const get = (t: string): string =>
    parts.find((p) => p.type === t)?.value ?? '';
  return {
    weekday: WEEKDAY_INDEX[get('weekday')] ?? 0,
    minutes: Number(get('hour')) * 60 + Number(get('minute')),
    ymd: `${get('year')}-${get('month')}-${get('day')}`,
  };
}
