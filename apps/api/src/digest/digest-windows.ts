import { localParts } from '../stock/market-hours';

/**
 * Daily Brief 投递窗口判断（PRD DB.1 · 模式 C）。
 *
 * 与 stock/market-hours 的 resolveMarketState 不同：那个返回「市场状态」
 * （PRE = 全盘前 04:00-09:30），这里要的是**窄投递窗口**——开盘前 30~5min /
 * 收盘后 5~30min。heartbeat 命中这些窄窗口才生成+投递。
 *
 * DST 100% 交给 market-hours.ts 的 localParts（Intl，交易所时区正确）。
 *
 * 节假日（决策 1）：Phase A 不查成交，按窗口时间发。节假日命中窗口会基于上一
 * 交易日数据发简报（BriefPayload.dataAsOf 反映真实时点，用户可辨识）。精确
 * 节假日判断留 Phase B（PRD §9）。周末不发（窗口判断前先排周末）。
 */

const hhmm = (h: number, m: number): number => h * 60 + m;

interface Window {
  tz: string;
  /** 开盘前 30~5min（heartbeat 命中即发）。 */
  pre: readonly [number, number];
  /** 收盘后 5~30min。 */
  post: readonly [number, number];
}

const WINDOWS: Record<'US' | 'CN' | 'HK', Window> = {
  // 开盘 09:30 / 收盘 16:00 ET
  US: {
    tz: 'America/New_York',
    pre: [hhmm(8, 30), hhmm(9, 25)],
    post: [hhmm(16, 5), hhmm(16, 30)],
  },
  // 开盘 09:30 / 收盘 15:00 CST（午间休市不影响窗口）
  CN: {
    tz: 'Asia/Shanghai',
    pre: [hhmm(9, 0), hhmm(9, 25)],
    post: [hhmm(15, 5), hhmm(15, 30)],
  },
  // 开盘 09:30 / 收盘 16:00 HKT
  HK: {
    tz: 'Asia/Hong_Kong',
    pre: [hhmm(9, 0), hhmm(9, 25)],
    post: [hhmm(16, 5), hhmm(16, 30)],
  },
};

export type DigestMarket = 'US' | 'CN' | 'HK';
export type DigestSession = 'PRE' | 'POST';

export interface DigestWindowHit {
  market: DigestMarket;
  session: DigestSession;
  /** 当地交易所时区 ymd（幂等键组成部分，PRD DB.1 line 236）。 */
  localYmd: string;
}

/**
 * 判断给定时刻是否命中某市场的 PRE/POST 窗口。命中返回 {market, session,
 * localYmd}；否则 null。周末不命中（localParts.weekday 6/0）。
 */
export function resolveDigestWindow(
  market: DigestMarket,
  at: Date = new Date(),
): DigestWindowHit | null {
  const w = WINDOWS[market];
  const now = localParts(w.tz, at);
  if (now.weekday === 0 || now.weekday === 6) return null; // 周末

  // PRE 窗口 [start, end] 闭区间：PRD「开盘前 30~5min」——到距开盘 5min 那一刻
  // 仍发（09:25 仍命中）。POST 窗口 [start, end) 半开：「收盘后 5~30min」——到
  // 30min 那一刻已超（16:30 不含）。
  const inPre = now.minutes >= w.pre[0] && now.minutes <= w.pre[1];
  if (inPre) return { market, session: 'PRE', localYmd: now.ymd };

  const inPost = now.minutes >= w.post[0] && now.minutes < w.post[1];
  if (inPost) return { market, session: 'POST', localYmd: now.ymd };

  return null;
}

/** 该市场所有支持的市场代号（遍历用）。 */
export const DIGEST_MARKETS: readonly DigestMarket[] = ['US', 'CN', 'HK'];
