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
 * RFC-02 §8.2 — A-share 龙虎榜 (LHB) scan.
 *
 * Returns the past N days of LHB appearances for a stock: date, reason
 * (e.g. 涨幅偏离7%/换手率20%), and TOP-5 buy/sell seats (营业部 names).
 *
 * Source (per CN_SOURCE_PRIORITIES.lhbAppearances): eastmoney only.
 * The endpoint `RPT_DAILYBILLBOARD_DETAILS` returns one row per (date, side)
 * combination; we group by date in post-processing.
 */

export const LhbScanInputSchema = z.object({
  symbol: z.string().min(1),
  market: z.literal('CN'),
  /** Days back to scan. Default 30, hard cap 90. */
  daysBack: z.number().int().positive().max(90).optional(),
});
export type LhbScanInput = z.infer<typeof LhbScanInputSchema>;

/**
 * plan-v2 Wave 1.4 — extract seat-level amounts and follow-up returns.
 * plan-v2 §5.1 — extended to cover RPT_DAILYBILLBOARD_DETAILS more fully.
 *
 * Single seat row. Amounts in 元 (raw values from Eastmoney — no scaling
 * applied beyond Number coercion). `code` + `isInstitutional` were added
 * so callers can distinguish 游资营业部 (code-identified individual
 * branches) from 机构席位 (anonymous institutional flow) — the key
 * dichotomy in A-share game-pattern reads.
 */
const LhbSeatSchema = z.object({
  name: z.string(),
  /** Branch identifier (OPERATEDEPT_CODE). Empty string for 机构席位 / unknown. */
  code: z.string(),
  /** True when this row represents an anonymous institutional seat (IS_ORG=1). */
  isInstitutional: z.boolean(),
  buyAmount: z.number().nullable(),
  sellAmount: z.number().nullable(),
  netAmount: z.number().nullable(),
});
export type LhbSeat = z.infer<typeof LhbSeatSchema>;

export const LhbScanOutputSchema = z.object({
  appearances: z.array(
    z.object({
      date: z.string(),
      reason: z.string(),
      /**
       * plan-v2 §5.1 — Eastmoney's EXPLAIN_TYPE code (e.g. '002' = 涨幅
       * 偏离 / '007' = 换手率 / '004' = 振幅）. Stable for grouping reason
       * stats independent of the human-readable string.
       */
      reasonCode: z.string().nullable(),
      // Day-level aggregates (元)
      buyAmount: z.number().nullable(),
      sellAmount: z.number().nullable(),
      netAmount: z.number().nullable(),
      dealAmount: z.number().nullable(),
      /**
       * plan-v2 §5.1 — 龙虎榜成交占当日大盘成交比（%）. Key signal:
       * >30% means LHB drove the day, <5% means LHB is incidental.
       */
      billboardDealRatio: z.number().nullable(),
      /** Free float market cap on the LHB day (元) — context for sizing. */
      freeMarketCap: z.number().nullable(),
      /** Number of distinct buy / sell seats appearing on the day. */
      billboardBuyNum: z.number().nullable(),
      billboardSellNum: z.number().nullable(),
      // Day price action
      closePrice: z.number().nullable(),
      changePct: z.number().nullable(),
      turnoverRate: z.number().nullable(),
      // Follow-up returns (%; null when day hasn't elapsed)
      changePctFollowing1d: z.number().nullable(),
      changePctFollowing2d: z.number().nullable(),
      changePctFollowing3d: z.number().nullable(),
      changePctFollowing5d: z.number().nullable(),
      changePctFollowing10d: z.number().nullable(),
      changePctFollowing20d: z.number().nullable(),
      // Seats
      topBuySeats: z.array(LhbSeatSchema),
      topSellSeats: z.array(LhbSeatSchema),
      // Backward-compatible name-only views (legacy consumers)
      topBuySeatNames: z.array(z.string()),
      topSellSeatNames: z.array(z.string()),
    }),
  ),
});
export type LhbScanOutput = z.infer<typeof LhbScanOutputSchema>;

const defaultFetch: CnToolFetchLike = (url, init) =>
  globalThis.fetch(url, init) as Promise<
    ReturnType<CnToolFetchLike> extends Promise<infer T> ? T : never
  >;

export function makeLhbScanCN(opts?: {
  fetchImpl?: CnToolFetchLike;
}): ToolDescriptor<LhbScanInput, LhbScanOutput> {
  const fetchImpl = opts?.fetchImpl ?? defaultFetch;
  return {
    name: 'lhbScan',
    description: 'A-share LHB (龙虎榜) appearances and top seats.',
    providerInternal: false,
    market: 'CN',
    factField: 'lhbAppearances',
    inputSchema: LhbScanInputSchema,
    outputSchema: LhbScanOutputSchema,
    async run(input, ctx): Promise<ToolResult<LhbScanOutput>> {
      const startedAt = Date.now();
      const daysBack = input.daysBack ?? 30;
      const priorities = resolveSourcePriorities(
        ctx.marketProfile,
        'lhbAppearances',
      );

      const errors: Array<{ source: string; message: string }> = [];
      for (let i = 0; i < priorities.length; i++) {
        const source = priorities[i];
        try {
          const result = await tryFetch(
            source,
            input.symbol,
            daysBack,
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
        `lhbScan exhausted sources [${priorities.join(',')}]: ${summary}`,
      );
    },
  };
}

interface FetchResult {
  data: LhbScanOutput;
  citations: Citation[];
}

async function tryFetch(
  source: string,
  symbol: string,
  daysBack: number,
  marketProfile: MarketProfile | undefined,
  fetchImpl: CnToolFetchLike,
  signal?: AbortSignal,
): Promise<FetchResult> {
  if (source === 'eastmoney') {
    return fetchFromEastmoney(symbol, daysBack, marketProfile, fetchImpl, signal);
  }
  throw new Error(`unknown source: ${source}`);
}

async function fetchFromEastmoney(
  symbol: string,
  daysBack: number,
  _marketProfile: MarketProfile | undefined,
  fetchImpl: CnToolFetchLike,
  signal?: AbortSignal,
): Promise<FetchResult> {
  const code = symbol.split('.')[0];
  // RPT_DAILYBILLBOARD_DETAILS returns daily LHB rows. We pull page 1
  // sorted by TRADE_DATE desc + filter on SECURITY_CODE; pageSize caps
  // results since the same date may yield multiple reason rows.
  const url =
    `https://datacenter-web.eastmoney.com/api/data/v1/get?` +
    `reportName=RPT_DAILYBILLBOARD_DETAILS` +
    `&columns=ALL&source=WEB` +
    `&sortColumns=TRADE_DATE&sortTypes=-1` +
    `&pageNumber=1&pageSize=100` +
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
  const rows = parsedBody?.result?.data;
  if (!Array.isArray(rows)) {
    // code 9201 / null result = no LHB appearances for this stock (valid +
    // common). Return empty rather than a hard connector_error.
    return {
      data: { appearances: [] },
      citations: [
        {
          title: `东方财富 龙虎榜 ${symbol}`,
          url,
          sourceType: 'OTHER',
          retrievedAt: new Date().toISOString(),
        },
      ],
    };
  }

  // Group by trade date. Each row may carry one reason; same-date rows are
  // merged. Empty result is OK (just means no LHB in window).
  const byDate = new Map<string, LhbScanOutput['appearances'][number]>();
  const cutoffMs = Date.now() - daysBack * 86_400_000;

  for (const r of rows) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    const dateStr =
      typeof o.TRADE_DATE === 'string' ? o.TRADE_DATE.split(' ')[0] : null;
    if (!dateStr) continue;
    const t = Date.parse(dateStr);
    if (!Number.isFinite(t) || t < cutoffMs) continue;
    const reason = typeof o.EXPLANATION === 'string' ? o.EXPLANATION : '';

    let entry = byDate.get(dateStr);
    if (!entry) {
      entry = {
        date: dateStr,
        reason,
        reasonCode: typeof o.EXPLAIN_TYPE === 'string' ? o.EXPLAIN_TYPE : null,
        buyAmount: pickNum(o.BILLBOARD_BUY_AMT),
        sellAmount: pickNum(o.BILLBOARD_SELL_AMT),
        netAmount: pickNum(o.BILLBOARD_NET_AMT),
        dealAmount: pickNum(o.BILLBOARD_DEAL_AMT),
        billboardDealRatio: pickNum(o.BILLBOARD_DEAL_AMT_RATE),
        freeMarketCap: pickNum(o.FREE_MARKET_CAP),
        billboardBuyNum: pickNum(o.BILLBOARD_BUY_NUM),
        billboardSellNum: pickNum(o.BILLBOARD_SELL_NUM),
        closePrice: pickNum(o.CLOSE_PRICE),
        changePct: pickNum(o.CHANGE_RATE),
        turnoverRate: pickNum(o.TURNOVERRATE),
        changePctFollowing1d: pickNum(o.D1_CLOSE_ADJCHRATE),
        changePctFollowing2d: pickNum(o.D2_CLOSE_ADJCHRATE),
        changePctFollowing3d: pickNum(o.D3_CLOSE_ADJCHRATE),
        changePctFollowing5d: pickNum(o.D5_CLOSE_ADJCHRATE),
        changePctFollowing10d: pickNum(o.D10_CLOSE_ADJCHRATE),
        changePctFollowing20d: pickNum(o.D20_CLOSE_ADJCHRATE),
        topBuySeats: [],
        topSellSeats: [],
        topBuySeatNames: [],
        topSellSeatNames: [],
      };
      byDate.set(dateStr, entry);
    } else if (reason && !entry.reason.includes(reason)) {
      entry.reason = entry.reason ? `${entry.reason}; ${reason}` : reason;
    }

    // Seat-level rows: Eastmoney returns one row per (date, seat, side).
    // Buy + sell amounts live on the same row when both sides exist.
    const buyName =
      typeof o.OPERATEDEPT_NAME === 'string' ? o.OPERATEDEPT_NAME :
      typeof o.BUYER_OPERATEDEPT_NAME === 'string' ? o.BUYER_OPERATEDEPT_NAME :
      null;
    const sellName =
      typeof o.SELLER_OPERATEDEPT_NAME === 'string' ? o.SELLER_OPERATEDEPT_NAME : null;

    const buyAmt = pickNum(o.BUY);
    const sellAmt = pickNum(o.SELL);
    const netAmt = pickNum(o.NET);
    // Seat identification: empty for 机构席位 (anonymous) — same name
    // ('机构席位') appears every day but represents different institutions.
    const code =
      typeof o.OPERATEDEPT_CODE === 'string' ? o.OPERATEDEPT_CODE :
      typeof o.BUYER_OPERATEDEPT_CODE === 'string' ? o.BUYER_OPERATEDEPT_CODE :
      '';
    // IS_ORG: '1' / 1 = anonymous institutional seat; '0' / 0 = named branch.
    const isInstitutional =
      o.IS_ORG === 1 || o.IS_ORG === '1' || o.IS_ORG === true;

    if (buyName) {
      const existing = entry.topBuySeats.find((s) => s.name === buyName);
      if (!existing && entry.topBuySeats.length < 5) {
        entry.topBuySeats.push({
          name: buyName,
          code,
          isInstitutional,
          buyAmount: buyAmt,
          sellAmount: sellAmt,
          netAmount: netAmt,
        });
        if (!entry.topBuySeatNames.includes(buyName)) entry.topBuySeatNames.push(buyName);
      }
    }
    if (sellName) {
      const existing = entry.topSellSeats.find((s) => s.name === sellName);
      if (!existing && entry.topSellSeats.length < 5) {
        entry.topSellSeats.push({
          name: sellName,
          code:
            typeof o.SELLER_OPERATEDEPT_CODE === 'string'
              ? o.SELLER_OPERATEDEPT_CODE
              : code,
          isInstitutional,
          buyAmount: buyAmt,
          sellAmount: sellAmt,
          netAmount: netAmt,
        });
        if (!entry.topSellSeatNames.includes(sellName)) entry.topSellSeatNames.push(sellName);
      }
    }
  }

  const appearances = Array.from(byDate.values()).sort((a, b) =>
    a.date < b.date ? 1 : -1,
  );

  return {
    data: { appearances },
    citations: [
      {
        title: `东方财富 龙虎榜 ${symbol}`,
        url,
        sourceType: 'OTHER',
        retrievedAt: new Date().toISOString(),
      },
    ],
  };
}

// ===== Helpers =====

function pickNum(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const trimmed = v.trim();
    if (trimmed === '' || trimmed === '-' || trimmed === 'null') return null;
    const n = parseFloat(trimmed);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function resolveSourcePriorities(
  profile: MarketProfile | undefined,
  fact: string,
): string[] {
  const fromProfile = profile?.sourcePriorities?.[fact];
  if (fromProfile && fromProfile.length > 0) return fromProfile;
  return ['eastmoney'];
}

export const lhbScanCN = makeLhbScanCN();
