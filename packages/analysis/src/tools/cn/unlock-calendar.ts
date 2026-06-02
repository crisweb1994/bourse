import { z } from 'zod';
import type { Citation } from '../../contracts/citation';
import type { MarketProfile } from '../../markets/types';
import type {
  ToolContext,
  ToolDescriptor,
  ToolResult,
} from '../types';
import type { CnToolFetchLike } from './_fetch-headers';
import { cnBrowserHeaders } from './_fetch-headers';

/**
 * RFC-02 §8.2 — A-share 限售解禁 (unlock calendar).
 *
 * Returns scheduled unlocks for the stock in the next N days: date,
 * shares unlocking, optional market value (亿元), and unlock type
 * (首发原股东限售股 / 股权激励 / 定增 etc.).
 *
 * Source (per CN_SOURCE_PRIORITIES.unlockCalendar):
 *   1. eastmoney `RPT_MAIN_NXTLIFT_SHARES_DETAIL` (implemented).
 *   2. cninfo (not implemented in RFC-02 Phase 1 — kept for future).
 */

export const UnlockCalendarInputSchema = z.object({
  symbol: z.string().min(1),
  market: z.literal('CN'),
  /** Days ahead to include. Default 90, hard cap 365. */
  daysAhead: z.number().int().positive().max(365).optional(),
});
export type UnlockCalendarInput = z.infer<typeof UnlockCalendarInputSchema>;

export const UnlockCalendarOutputSchema = z.object({
  events: z.array(
    z.object({
      date: z.string(),
      shares: z.number().positive(),
      marketValue: z.number().nonnegative().optional(),
      type: z.string(),
    }),
  ),
});
export type UnlockCalendarOutput = z.infer<typeof UnlockCalendarOutputSchema>;

const defaultFetch: CnToolFetchLike = (url, init) =>
  globalThis.fetch(url, init) as Promise<
    ReturnType<CnToolFetchLike> extends Promise<infer T> ? T : never
  >;

export function makeUnlockCalendarCN(opts?: {
  fetchImpl?: CnToolFetchLike;
}): ToolDescriptor<UnlockCalendarInput, UnlockCalendarOutput> {
  const fetchImpl = opts?.fetchImpl ?? defaultFetch;
  return {
    name: 'unlockCalendar',
    description: 'A-share 限售解禁 schedule for the next N days.',
    providerInternal: false,
    market: 'CN',
    factField: 'unlockCalendar',
    inputSchema: UnlockCalendarInputSchema,
    outputSchema: UnlockCalendarOutputSchema,
    async run(input, ctx): Promise<ToolResult<UnlockCalendarOutput>> {
      const startedAt = Date.now();
      const daysAhead = input.daysAhead ?? 90;
      const priorities = resolveSourcePriorities(
        ctx.marketProfile,
        'unlockCalendar',
      );

      const errors: Array<{ source: string; message: string }> = [];
      for (let i = 0; i < priorities.length; i++) {
        const source = priorities[i];
        try {
          const result = await tryFetch(
            source,
            input.symbol,
            daysAhead,
            ctx.marketProfile,
            fetchImpl,
            ctx.signal,
          );
          return {
            data: result.data,
            citations: result.citations,
            cost: { tokensIn: 0, tokensOut: 0 },
            trace: {
              source,
              durationMs: Date.now() - startedAt,
              fallbacksTriggered: i,
            },
          };
        } catch (err) {
          errors.push({
            source,
            message: err instanceof Error ? err.message : String(err),
          });
          if (err instanceof Error && /retry-after/i.test(err.message)) {
            throw err;
          }
        }
      }

      const summary = errors.map((e) => `${e.source}: ${e.message}`).join('; ');
      throw new Error(
        `unlockCalendar exhausted sources [${priorities.join(',')}]: ${summary}`,
      );
    },
  };
}

interface FetchResult {
  data: UnlockCalendarOutput;
  citations: Citation[];
}

async function tryFetch(
  source: string,
  symbol: string,
  daysAhead: number,
  marketProfile: MarketProfile | undefined,
  fetchImpl: CnToolFetchLike,
  signal?: AbortSignal,
): Promise<FetchResult> {
  if (source === 'eastmoney') {
    return fetchFromEastmoney(symbol, daysAhead, marketProfile, fetchImpl, signal);
  }
  if (source === 'cninfo') {
    throw new Error(
      `cninfo unlockCalendar not implemented in RFC-02 Phase 1 (future RFC)`,
    );
  }
  throw new Error(`unknown source: ${source}`);
}

async function fetchFromEastmoney(
  symbol: string,
  daysAhead: number,
  _marketProfile: MarketProfile | undefined,
  fetchImpl: CnToolFetchLike,
  signal?: AbortSignal,
): Promise<FetchResult> {
  const code = symbol.split('.')[0];
  // eastmoney retired RPT_MAIN_NXTLIFT_SHARES_DETAIL (verified 2026 → "报表配置
  // 不存在"). Repointed to the live per-stock unlock report RPT_LIFT_STAGE.
  // Unit note (verified via FREE_RATIO + a real unlock): FREE_SHARES is 万股
  // and LIFT_MARKET_CAP is 万元 — normalized below to raw 股 / 亿元 so this
  // tool's output units are unchanged.
  const url =
    `https://datacenter-web.eastmoney.com/api/data/v1/get?` +
    `reportName=RPT_LIFT_STAGE` +
    `&columns=SECURITY_CODE,FREE_DATE,FREE_SHARES,LIFT_MARKET_CAP,FREE_RATIO,FREE_SHARES_TYPE` +
    `&pageNumber=1&pageSize=50` +
    `&sortColumns=FREE_DATE&sortTypes=1` +
    `&filter=(SECURITY_CODE%3D%22${code}%22)`;

  const res = await fetchImpl(url, { signal, headers: cnBrowserHeaders });
  if (!res.ok) {
    if (res.status === 429) throw new Error(`eastmoney 429 retry-after: 30`);
    throw new Error(`eastmoney HTTP ${res.status}`);
  }
  const body = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error(`eastmoney: JSON parse failed`);
  }
  const parsedBody = parsed as {
    result?: { data?: unknown };
    message?: string;
    code?: number;
  };
  if (parsedBody.code === 9501) {
    throw new Error(
      `eastmoney: report config not found (${parsedBody.message ?? 'no message'})`,
    );
  }
  const data = parsedBody?.result?.data;
  if (!Array.isArray(data)) {
    // code 9201 / null result = no unlock records for this stock (valid + common
    // for mature stocks with no pending unlocks). Return empty rather than a
    // hard connector_error — "no unlocks scheduled" is itself a positive signal.
    return {
      data: { events: [] },
      citations: [
        {
          title: `东方财富 限售解禁 ${symbol}`,
          url,
          sourceType: 'OTHER',
          retrievedAt: new Date().toISOString(),
        },
      ],
    };
  }

  const nowMs = Date.now();
  const cutoffMs = nowMs + daysAhead * 86_400_000;
  const events: UnlockCalendarOutput['events'] = [];

  for (const r of data) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    const dateStr =
      typeof o.FREE_DATE === 'string' ? o.FREE_DATE.split(' ')[0] : null;
    if (!dateStr) continue;
    const t = Date.parse(dateStr);
    if (!Number.isFinite(t)) continue;
    // Within window: from now to (now + daysAhead). Past events are skipped
    // — the caller can use a separate "historical unlocks" query if needed.
    if (t < nowMs - 86_400_000 || t > cutoffMs) continue;

    // FREE_SHARES is 万股 → raw 股; LIFT_MARKET_CAP is 万元 → 亿元.
    const sharesWan = pickPositive(o.FREE_SHARES);
    if (sharesWan === null) continue;
    const shares = sharesWan * 1e4;
    const mcRaw = pickFloat(o.LIFT_MARKET_CAP);
    const marketValueYi =
      mcRaw !== null && mcRaw >= 0 ? mcRaw / 1e4 : undefined;
    const type =
      typeof o.FREE_SHARES_TYPE === 'string' && o.FREE_SHARES_TYPE
        ? o.FREE_SHARES_TYPE
        : '未分类';

    events.push({
      date: dateStr,
      shares,
      ...(marketValueYi !== undefined ? { marketValue: marketValueYi } : {}),
      type,
    });
  }

  return {
    data: { events },
    citations: [
      {
        title: `东方财富 限售解禁 ${symbol}`,
        url,
        sourceType: 'OTHER',
        retrievedAt: new Date().toISOString(),
      },
    ],
  };
}

// ===== Helpers =====

function pickPositive(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v;
  if (typeof v === 'string') {
    const n = parseFloat(v);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

function pickFloat(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = parseFloat(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function resolveSourcePriorities(
  profile: MarketProfile | undefined,
  fact: string,
): string[] {
  const fromProfile = profile?.sourcePriorities?.[fact];
  if (fromProfile && fromProfile.length > 0) return fromProfile;
  return ['eastmoney', 'cninfo'];
}

export const unlockCalendarCN = makeUnlockCalendarCN();
