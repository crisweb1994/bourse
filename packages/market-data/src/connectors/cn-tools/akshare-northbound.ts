import { z } from 'zod';
import type {
  MarketDataToolCitation as Citation,
  MarketDataToolProfile as MarketProfile,
  MarketDataToolContext as ToolContext,
  MarketDataToolDescriptor as ToolDescriptor,
  MarketDataToolResult as ToolResult,
} from './types';
import type { CnToolFetchLike } from './_fetch-headers';
import { cnBrowserHeaders } from './_fetch-headers';

/**
 * plan-v2 Wave 1.7 — A-share northbound holdings via akshare-compatible
 * endpoints (2026-05-25 decision).
 *
 * Replaces the previous `RPT_MUTUAL_STOCK_HOLDRANKS_DETAILS` connector
 * which was silently returning empty since Eastmoney deprecated that
 * endpoint (data.md flagged).
 *
 * Strategy: use the Eastmoney stock-connect holding-detail endpoint. The
 * public per-stock `fflow/daykline` endpoint is generic fund flow, not
 * northbound flow, so it is deliberately not used as a fallback. Showing it
 * as northbound would be worse than an explicit missing-flow state.
 *
 * IMPORTANT: when ALL endpoints fail (rate limit / endpoint moved /
 * network), the connector throws with an explicit
 * `not_implemented`-style error rather than returning empty. This is the
 * data-integrity stance plan-v2 §5.3 calls for ("not implemented"
 * surfaces in dataAvailability; silent empty is treated as a regression).
 *
 * The row shape remains additive-compatible with existing consumers; rows
 * carrying holding fields are classified as holdings by the canonical
 * adapter, while genuine flow fields are never fabricated from market-cap
 * deltas.
 */

export const AkshareNorthboundInputSchema = z.object({
  symbol: z.string().min(1),
  market: z.literal('CN'),
  /** Number of holding snapshots to request. Default 20, hard cap 60. */
  daysBack: z.number().int().positive().max(60).optional(),
});
export type AkshareNorthboundInput = z.infer<typeof AkshareNorthboundInputSchema>;

export const AkshareNorthboundOutputSchema = z.object({
  rows: z.array(
    z.object({
      date: z.string(),
      hgt: z.number(), // genuine 沪股通 flow when the source provides it
      sgt: z.number(), // genuine 深股通 flow when the source provides it
      holdShares: z.number().nullable(), // 当日持股股数 (万股, null if endpoint omits)
      holdMarketValue: z.number().nullable(), // 持股市值 (亿元)
      holdPctOfFloat: z.number().nullable(), // 持股占流通股比 (decimal, e.g. 0.05)
    }),
  ),
  /** Which mirror succeeded (for telemetry). */
  sourceMirror: z.string(),
});
export type AkshareNorthboundOutput = z.infer<typeof AkshareNorthboundOutputSchema>;

const defaultFetch: CnToolFetchLike = (url, init) =>
  globalThis.fetch(url, init) as Promise<
    ReturnType<CnToolFetchLike> extends Promise<infer T> ? T : never
  >;

/**
 * Mirror endpoints — ordered by historical stability. The first one to
 * return a non-empty response wins. Each builder receives the parsed
 * symbol + window and returns a fetchable URL.
 *
 * Wave 0 should periodically re-verify each mirror is live and reorder.
 * See plan-v2 §17.1 (akshare mirror stability risk).
 */
const NORTHBOUND_MIRRORS: ReadonlyArray<{
  name: string;
  buildUrl: (code: string, exchange: 'SS' | 'SZ', daysBack: number) => string;
  parse: (body: unknown) => AkshareNorthboundOutput['rows'];
}> = [
  // Eastmoney datacenter HSGT holding detail per stock (same
  // backend akshare's `stock_hsgt_hold_stock_em` uses).
  // 2026-08-15: Eastmoney renamed the sort/date column HOLD_DATE → TRADE_DATE
  // and reshaped the payload (HOLD_SHARES_NUM → HOLD_SHARES in raw shares,
  // ratios under *_SHARES_RATIO, daily delta via HOLD_MARKETCAP_CHG1). The
  // daily per-stock disclosure itself has stopped (quarter-end snapshots
  // only), so this mirror now primarily serves the latest holding snapshot.
  {
    name: 'eastmoney-datacenter',
    buildUrl: (code, _exchange, daysBack) => {
      // RPT_MUTUAL_HOLDSTOCKNORTH_STA returns per-stock north-bound holding.
      return (
        `https://datacenter.eastmoney.com/securities/api/data/v1/get?` +
        `reportName=RPT_MUTUAL_HOLDSTOCKNORTH_STA` +
        `&columns=ALL&source=WEB` +
        `&sortColumns=TRADE_DATE&sortTypes=-1` +
        `&pageNumber=1&pageSize=${daysBack}` +
        `&filter=(SECURITY_CODE%3D%22${code}%22)`
      );
    },
    parse: (body) => parseEastmoneyHoldDetail(body),
  },
];

export function makeAkshareNorthboundCN(opts?: {
  fetchImpl?: CnToolFetchLike;
  /** Override the mirror list (Wave 0 tests use this to inject fixtures). */
  mirrors?: typeof NORTHBOUND_MIRRORS;
}): ToolDescriptor<AkshareNorthboundInput, AkshareNorthboundOutput> {
  const fetchImpl = opts?.fetchImpl ?? defaultFetch;
  const mirrors = opts?.mirrors ?? NORTHBOUND_MIRRORS;
  return {
    name: 'akshareNorthbound',
    description: 'A-share northbound holding snapshots via Eastmoney.',
    providerInternal: false,
    market: 'CN',
    factField: 'northboundFlow',
    inputSchema: AkshareNorthboundInputSchema,
    outputSchema: AkshareNorthboundOutputSchema,
    async run(input, ctx): Promise<ToolResult<AkshareNorthboundOutput>> {
      const startedAt = Date.now();
      const daysBack = input.daysBack ?? 20;
      const code = input.symbol.split('.')[0]!;
      const exchange = inferExchange(input.symbol);

      const errors: Array<{ mirror: string; message: string }> = [];
      for (const mirror of mirrors) {
        const url = mirror.buildUrl(code, exchange, daysBack);
        try {
          const res = await fetchImpl(url, {
            signal: ctx.signal,
            headers: cnBrowserHeaders,
          });
          if (!res.ok) {
            if (res.status === 429) throw new Error(`${mirror.name} 429 retry-after: 30`);
            throw new Error(`${mirror.name} HTTP ${res.status}`);
          }
          const text = await res.text();
          let parsed: unknown;
          try {
            parsed = JSON.parse(text);
          } catch {
            throw new Error(`${mirror.name}: JSON parse failed`);
          }
          const rows = mirror.parse(parsed).slice(0, daysBack);
          if (rows.length === 0) {
            // Empty from this mirror — try next instead of returning empty
            errors.push({ mirror: mirror.name, message: 'empty rows' });
            continue;
          }
          return {
            data: { rows, sourceMirror: mirror.name },
            citations: [
              {
                title: `北向持股 ${input.symbol} (via ${mirror.name})`,
                url,
                sourceType: 'OTHER',
                retrievedAt: new Date().toISOString(),
              } as Citation,
            ],
            cost: { tokensIn: 0, tokensOut: 0 },
            trace: {
              source: mirror.name,
              durationMs: Date.now() - startedAt,
              fallbacksTriggered: mirrors.indexOf(mirror),
            },
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          errors.push({ mirror: mirror.name, message: msg });
          if (err instanceof Error && /retry-after/i.test(err.message)) {
            throw err;
          }
        }
      }

      // All mirrors failed — surface explicitly, do NOT silently return empty
      const summary = errors.map((e) => `${e.mirror}: ${e.message}`).join('; ');
      const err = new Error(
        `akshareNorthbound: all mirrors failed [${mirrors.map((m) => m.name).join(',')}]: ${summary} (treat as not_implemented in dataAvailability)`,
      );
      // Tag for the wrapper to translate into a `not_implemented` reason
      (err as Error & { reason?: string }).reason = 'not_implemented';
      throw err;
    },
  };
}

// ============================================================================
// Parsers
// ============================================================================

function parseEastmoneyHoldDetail(body: unknown): AkshareNorthboundOutput['rows'] {
  const rows = (body as { result?: { data?: unknown } })?.result?.data;
  if (!Array.isArray(rows)) return [];
  const out: AkshareNorthboundOutput['rows'] = [];
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    // 2026-08 schema: date lives in TRADE_DATE (HOLD_DATE no longer exists).
    const date =
      typeof o.TRADE_DATE === 'string'
        ? o.TRADE_DATE.split(' ')[0]!
        : typeof o.HOLD_DATE === 'string'
          ? o.HOLD_DATE.split(' ')[0]!
          : null;
    if (!date) continue;
    // HOLD_MARKETCAP_CHG1 is a marked-to-market holding-value delta. It mixes
    // price movement with trading, so it is intentionally NOT exposed as
    // northbound net flow.
    const net = pickFloat(o.ADD_MARKET_CAP) ?? pickFloat(o.NET_BUY_AMT);
    // HOLD_SHARES_NUM was already 万股 (legacy); HOLD_SHARES is raw shares (2026-08 schema).
    const legacyShares = pickFloat(o.HOLD_SHARES_NUM);
    const sharesNew = pickFloat(o.HOLD_SHARES);
    const holdShares =
      legacyShares !== null
        ? legacyShares
        : sharesNew !== null
          ? sharesNew / 1e4
          : null;
    // HOLD_MARKET_CAP kept its name but switched 亿元 → 元 in the 2026-08
    // schema. Any real holding in 元 is ≥ ~1e8; in 亿元 it is ≤ ~1e5 — a
    // magnitude split cleanly separates the two without extra round-trips.
    const capRaw = pickFloat(o.HOLD_MARKET_CAP);
    const holdMarketValue = capRaw !== null ? (capRaw >= 1e6 ? capRaw / 1e8 : capRaw) : null;
    const holdPctOfFloat =
      pickDecimalFromPct(o.SHARES_HOLDRATIO) ??
      pickDecimalFromPct(o.FREE_SHARES_RATIO) ??
      pickDecimalFromPct(o.TOTAL_SHARES_RATIO);
    // A row is useful if it carries either an explicitly labelled flow or a
    // holding observation. Zero flow values are retained for compatibility,
    // but the canonical adapter will separate holding-only rows.
    if (net === null && holdShares === null && holdMarketValue === null) continue;
    // 沪股通 / 深股通 split: Eastmoney encodes via MUTUAL_TYPE (001=hgt, 003=sgt)
    const isHgt = String(o.MUTUAL_TYPE ?? '').endsWith('1');
    const isSgt = String(o.MUTUAL_TYPE ?? '').endsWith('3');
    out.push({
      date,
      hgt: net !== null && isHgt ? net : 0,
      sgt: net !== null && isSgt ? net : 0,
      holdShares,
      holdMarketValue,
      holdPctOfFloat,
    });
  }
  return out;
}

// ============================================================================
// Helpers
// ============================================================================

function inferExchange(symbol: string): 'SS' | 'SZ' {
  const code = symbol.split('.')[0]!;
  // 6xx → SS, others → SZ (300/000/002/003)
  if (/^6\d{5}$/.test(code)) return 'SS';
  return 'SZ';
}

function pickFloat(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const trimmed = v.trim();
    if (trimmed === '' || trimmed === '-' || trimmed === 'null') return null;
    const n = parseFloat(trimmed);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function pickDecimalFromPct(v: unknown): number | null {
  const f = pickFloat(v);
  if (f === null) return null;
  return f / 100;
}

export const akshareNorthboundCN = makeAkshareNorthboundCN();
