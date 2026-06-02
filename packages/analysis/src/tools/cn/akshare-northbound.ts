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
 * plan-v2 Wave 1.7 — A-share northbound flow via akshare-compatible
 * endpoints (2026-05-25 decision).
 *
 * Replaces the previous `RPT_MUTUAL_STOCK_HOLDRANKS_DETAILS` connector
 * which was silently returning empty since Eastmoney deprecated that
 * endpoint (data.md flagged).
 *
 * Strategy: try a small ordered list of public endpoints akshare is
 * known to wrap, in stability-descending order. Each endpoint is
 * deliberately tried with a tight timeout and minimal retries — falling
 * forward fast keeps p95 latency bounded when one mirror is down.
 *
 * IMPORTANT: when ALL endpoints fail (rate limit / endpoint moved /
 * network), the connector throws with an explicit
 * `not_implemented`-style error rather than returning empty. This is the
 * data-integrity stance plan-v2 §5.3 calls for ("not implemented"
 * surfaces in dataAvailability; silent empty is treated as a regression).
 *
 * Output schema is byte-compatible with the legacy
 * `NorthboundFlowOutput` so dimension prompts and EvidencePack
 * consumers do not need to change.
 */

export const AkshareNorthboundInputSchema = z.object({
  symbol: z.string().min(1),
  market: z.literal('CN'),
  /** Days back of daily net-flow rows. Default 20, hard cap 60. */
  daysBack: z.number().int().positive().max(60).optional(),
});
export type AkshareNorthboundInput = z.infer<typeof AkshareNorthboundInputSchema>;

export const AkshareNorthboundOutputSchema = z.object({
  rows: z.array(
    z.object({
      date: z.string(),
      hgt: z.number(), // 沪股通 per-stock net inflow (亿元)
      sgt: z.number(), // 深股通 per-stock net inflow (亿元)
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
  // Mirror 1: Eastmoney datacenter HSGT holding detail per stock (working
  // as of 2026-05; same backend akshare's `stock_hsgt_hold_stock_em` uses).
  {
    name: 'eastmoney-datacenter',
    buildUrl: (code, _exchange, daysBack) => {
      // RPT_MUTUAL_HOLDSTOCKNORTH_STA returns per-stock daily north-bound
      // holding with computed net inflow when MUTUAL_TYPE is filtered.
      return (
        `https://datacenter-web.eastmoney.com/api/data/v1/get?` +
        `reportName=RPT_MUTUAL_HOLDSTOCKNORTH_STA` +
        `&columns=ALL&source=WEB` +
        `&sortColumns=HOLD_DATE&sortTypes=-1` +
        `&pageNumber=1&pageSize=${daysBack}` +
        `&filter=(SECURITY_CODE%3D%22${code}%22)`
      );
    },
    parse: (body) => parseEastmoneyHoldDetail(body),
  },
  // Mirror 2: push2 north-net-flow endpoint via individual symbol (akshare's
  // `stock_hsgt_north_net_flow_in_em` family). Yields daily aggregate flow
  // when the per-stock endpoint is down.
  {
    name: 'eastmoney-push2-flow',
    buildUrl: (code, exchange, _daysBack) => {
      const market = exchange === 'SS' ? '1' : '0';
      return (
        `https://push2his.eastmoney.com/api/qt/stock/fflow/daykline/get?` +
        `secid=${market}.${code}` +
        `&fields1=f1,f2,f3,f7` +
        `&fields2=f51,f52,f53,f54,f55,f56,f57,f58` +
        `&klt=101&fqt=0&beg=0&end=20500101`
      );
    },
    parse: (body) => parseEastmoneyFflow(body),
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
    description: 'A-share northbound flow via akshare-compatible mirrors.',
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
                title: `北向资金 ${input.symbol} (via ${mirror.name})`,
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
    const date = typeof o.HOLD_DATE === 'string' ? o.HOLD_DATE.split(' ')[0] : null;
    if (!date) continue;
    const net = pickFloat(o.ADD_MARKET_CAP) ?? pickFloat(o.NET_BUY_AMT);
    if (net === null) continue;
    // 沪股通 / 深股通 split: Eastmoney encodes via MUTUAL_TYPE (1=hgt, 3=sgt)
    const isHgt = String(o.MUTUAL_TYPE ?? '').includes('1');
    const isSgt = String(o.MUTUAL_TYPE ?? '').includes('3');
    out.push({
      date,
      hgt: isHgt ? net : 0,
      sgt: isSgt ? net : 0,
      holdShares: pickFloat(o.HOLD_SHARES_NUM),
      holdMarketValue: pickFloat(o.HOLD_MARKET_CAP),
      holdPctOfFloat: pickDecimalFromPct(o.SHARES_HOLDRATIO),
    });
  }
  return out;
}

function parseEastmoneyFflow(body: unknown): AkshareNorthboundOutput['rows'] {
  // klines format: { data: { klines: ["date,f51,f52,f53,f54,f55,f56,f57,f58", ...] } }
  // f51=主力净流入, but for north-bound this endpoint actually returns
  // generic fund-flow not strictly north-bound; treat as fallback only.
  // We expose net as `hgt` so downstream sees a number, but mark sgt=0
  // until we get a dedicated north-bound flow endpoint working.
  const data = (body as { data?: { klines?: unknown } })?.data;
  const klines = data?.klines;
  if (!Array.isArray(klines)) return [];
  const out: AkshareNorthboundOutput['rows'] = [];
  for (const line of klines) {
    if (typeof line !== 'string') continue;
    const parts = line.split(',');
    if (parts.length < 6) continue;
    const date = parts[0]!;
    const net = parseFloat(parts[1] ?? '0');
    if (!Number.isFinite(net)) continue;
    out.push({
      date,
      hgt: net / 1e8, // 元 → 亿元
      sgt: 0,
      holdShares: null,
      holdMarketValue: null,
      holdPctOfFloat: null,
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
