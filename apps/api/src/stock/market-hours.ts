/**
 * Exchange trading-session → market state, computed in the EXCHANGE's own
 * timezone via `Intl` so the result is independent of the server's or the
 * user's timezone. Returns the Yahoo-style state strings the web header
 * understands (`REGULAR` / `PRE` / `POST` / `CLOSED`).
 *
 * Why this exists: the data sources don't reliably report live state — Yahoo's
 * v8 chart `meta.marketState` is null and the CN tencent payload has none — so
 * the detail panel would otherwise always read "已收盘". We derive it instead.
 *
 * Limitations: no static holiday calendar. For US/HK the real last-trade time
 * (Yahoo `regularMarketTime`) acts as a holiday guard — if the last trade
 * isn't from today's exchange-local date, REGULAR downgrades to CLOSED. CN
 * quotes carry no real trade time (timestamp = fetch time), so a CN holiday on
 * a weekday reads as REGULAR within session hours.
 */

export type MarketState = 'REGULAR' | 'PRE' | 'POST' | 'CLOSED';

const hhmm = (h: number, m: number): number => h * 60 + m;

interface Session {
  tz: string;
  /** [startMin, endMin) minutes-from-midnight, exchange local. */
  regular: ReadonlyArray<readonly [number, number]>;
  pre?: readonly [number, number];
  post?: readonly [number, number];
}

const SESSIONS: Record<string, Session> = {
  US: {
    tz: 'America/New_York',
    pre: [hhmm(4, 0), hhmm(9, 30)],
    regular: [[hhmm(9, 30), hhmm(16, 0)]],
    post: [hhmm(16, 0), hhmm(20, 0)],
  },
  CN: {
    // 09:30–11:30 morning, 13:00–15:00 afternoon; 午间休市 reads as CLOSED.
    tz: 'Asia/Shanghai',
    regular: [
      [hhmm(9, 30), hhmm(11, 30)],
      [hhmm(13, 0), hhmm(15, 0)],
    ],
  },
  HK: {
    // 09:30–12:00 morning, 13:00–16:00 afternoon; lunch reads as CLOSED.
    tz: 'Asia/Hong_Kong',
    regular: [
      [hhmm(9, 30), hhmm(12, 0)],
      [hhmm(13, 0), hhmm(16, 0)],
    ],
  },
};

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

const within = (min: number, w?: readonly [number, number]): boolean =>
  !!w && min >= w[0] && min < w[1];

/**
 * @param market    US | CN | HK (case-insensitive); anything else → CLOSED.
 * @param at        the instant to evaluate (defaults to now).
 * @param lastTradeIso optional real last-trade timestamp for the holiday guard.
 */
export function resolveMarketState(
  market: string,
  at: Date = new Date(),
  lastTradeIso?: string,
): MarketState {
  const session = SESSIONS[(market ?? '').trim().toUpperCase()];
  if (!session) return 'CLOSED';

  const now = localParts(session.tz, at);
  if (now.weekday === 0 || now.weekday === 6) return 'CLOSED'; // weekend

  if (session.regular.some((w) => within(now.minutes, w))) {
    if (lastTradeIso) {
      const lt = new Date(lastTradeIso);
      if (
        !Number.isNaN(lt.getTime()) &&
        localParts(session.tz, lt).ymd !== now.ymd
      ) {
        return 'CLOSED'; // holiday / no trade today despite session hours
      }
    }
    return 'REGULAR';
  }
  if (within(now.minutes, session.pre)) return 'PRE';
  if (within(now.minutes, session.post)) return 'POST';
  return 'CLOSED';
}
