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
 * plan-v2 Wave 1.6 — A-share 股东户数 (shareholder concentration).
 *
 * Resolves the `shareholderConcentration` fact key that has been
 * UNMAPPED since v0.7 (data.md flagged). Eastmoney's
 * `RPT_F10_EH_HOLDERNUM` endpoint reports (column names verified 2026 — the
 * old HOLDER_TOTAL_NUMCHANGEH / AVG_HOLD_NUM columns were dropped):
 *   - HOLDER_TOTAL_NUM:        total shareholder count
 *   - HOLDER_TOTAL_NUMCHANGE:  change vs prior reporting period (signed)
 *   - CHANGEWITHLAST:          H/H % change (was HOLDER_TOTAL_NUMCHANGEH)
 *   - AVG_HOLD_AMT:            average holding amount (元)
 *   - AVG_FREE_SHARES:         average free-float shares / holder (was AVG_HOLD_NUM)
 *   - HOLD_FOCUS:              CONCENTRATED / DISPERSED label (Chinese)
 *
 * Eastmoney typically publishes alongside quarterly reports; the report
 * cadence is irregular (some firms only quarterly, others monthly).
 * We return the latest N rows (default 4 → ~1y of quarterly data).
 *
 * Source priority:
 *   1. eastmoney (implemented)
 *   2. Future: Tonghuashun / Sina F10 — kept as fallback slot
 */

export const ShareholdersInputSchema = z.object({
  symbol: z.string().min(1),
  market: z.literal('CN'),
  /** Latest N quarters of holder-count snapshots. Default 4, cap 12. */
  quartersBack: z.number().int().positive().max(12).optional(),
});
export type ShareholdersInput = z.infer<typeof ShareholdersInputSchema>;

const ShareholdersRowSchema = z.object({
  endDate: z.string(), // 'YYYY-MM-DD' (data effective date)
  holderTotalNum: z.number().int().nonnegative(),
  holderTotalNumChange: z.number().int().nullable(),
  holderTotalNumChangePct: z.number().nullable(), // decimal, e.g. -0.05
  avgHoldAmount: z.number().nullable(), // 元
  avgHoldShares: z.number().nullable(),
  /** Eastmoney concentration label, e.g. '集中' / '分散'. Null when absent. */
  concentrationLabel: z.string().nullable(),
});
export type ShareholdersRow = z.infer<typeof ShareholdersRowSchema>;

export const ShareholdersOutputSchema = z.object({
  rows: z.array(ShareholdersRowSchema),
  /** Convenience: derived from the latest row's change. -1..+1 sign for prompt. */
  latestTrend: z.enum(['rising', 'falling', 'flat', 'unknown']),
});
export type ShareholdersOutput = z.infer<typeof ShareholdersOutputSchema>;

const defaultFetch: CnToolFetchLike = (url, init) =>
  globalThis.fetch(url, init) as Promise<
    ReturnType<CnToolFetchLike> extends Promise<infer T> ? T : never
  >;

export function makeShareholdersCN(opts?: {
  fetchImpl?: CnToolFetchLike;
}): ToolDescriptor<ShareholdersInput, ShareholdersOutput> {
  const fetchImpl = opts?.fetchImpl ?? defaultFetch;
  return {
    name: 'shareholders',
    description: 'A-share 股东户数 (shareholder concentration over time).',
    providerInternal: false,
    market: 'CN',
    factField: 'shareholderConcentration',
    inputSchema: ShareholdersInputSchema,
    outputSchema: ShareholdersOutputSchema,
    async run(input, ctx): Promise<ToolResult<ShareholdersOutput>> {
      const startedAt = Date.now();
      const quartersBack = input.quartersBack ?? 4;
      const priorities = resolveSourcePriorities(
        ctx.marketProfile,
        'shareholderConcentration',
      );

      const errors: Array<{ source: string; message: string }> = [];
      for (let i = 0; i < priorities.length; i++) {
        const source = priorities[i];
        try {
          const result = await tryFetch(
            source,
            input.symbol,
            quartersBack,
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
        `shareholders exhausted sources [${priorities.join(',')}]: ${summary}`,
      );
    },
  };
}

interface FetchResult {
  data: ShareholdersOutput;
  citations: Citation[];
}

async function tryFetch(
  source: string,
  symbol: string,
  quartersBack: number,
  marketProfile: MarketProfile | undefined,
  fetchImpl: CnToolFetchLike,
  signal?: AbortSignal,
): Promise<FetchResult> {
  if (source === 'eastmoney') {
    return fetchFromEastmoney(symbol, quartersBack, marketProfile, fetchImpl, signal);
  }
  throw new Error(`unknown source: ${source}`);
}

async function fetchFromEastmoney(
  symbol: string,
  quartersBack: number,
  _marketProfile: MarketProfile | undefined,
  fetchImpl: CnToolFetchLike,
  signal?: AbortSignal,
): Promise<FetchResult> {
  const code = symbol.split('.')[0];
  // SECURITY_CODE filter; sort by END_DATE desc; pageSize covers up to 12
  // quarters with margin for irregular cadence.
  const url =
    `https://datacenter-web.eastmoney.com/api/data/v1/get?` +
    `reportName=RPT_F10_EH_HOLDERNUM` +
    `&columns=SECURITY_CODE,END_DATE,HOLDER_TOTAL_NUM,HOLDER_TOTAL_NUMCHANGE,CHANGEWITHLAST,AVG_HOLD_AMT,AVG_FREE_SHARES,HOLD_FOCUS` +
    `&source=WEB` +
    `&sortColumns=END_DATE&sortTypes=-1` +
    `&pageNumber=1&pageSize=${Math.max(quartersBack, 4) * 2}` +
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
  const data = parsed as { result?: { data?: unknown }; message?: string; code?: number };
  if (data.code === 9501) {
    throw new Error(`eastmoney: report config not found (${data.message ?? 'no message'})`);
  }
  const rows = data?.result?.data;
  if (!Array.isArray(rows)) {
    // Empty result is valid (some IPOs have no data yet); return empty rows
    return {
      data: { rows: [], latestTrend: 'unknown' },
      citations: [makeCitation(symbol, url)],
    };
  }

  const parsedRows: ShareholdersRow[] = [];
  for (const r of rows.slice(0, quartersBack)) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    const endDate = typeof o.END_DATE === 'string' ? o.END_DATE.split(' ')[0] : null;
    const totalRaw = o.HOLDER_TOTAL_NUM;
    if (!endDate || (typeof totalRaw !== 'number' && typeof totalRaw !== 'string')) continue;
    const total = Number(totalRaw);
    if (!Number.isFinite(total) || total < 0) continue;

    parsedRows.push({
      endDate,
      holderTotalNum: Math.round(total),
      holderTotalNumChange: pickInt(o.HOLDER_TOTAL_NUMCHANGE),
      holderTotalNumChangePct: pickDecimalFromPct(o.CHANGEWITHLAST),
      avgHoldAmount: pickFloat(o.AVG_HOLD_AMT),
      avgHoldShares: pickFloat(o.AVG_FREE_SHARES),
      concentrationLabel: typeof o.HOLD_FOCUS === 'string' ? o.HOLD_FOCUS : null,
    });
  }

  return {
    data: {
      rows: parsedRows,
      latestTrend: deriveTrend(parsedRows),
    },
    citations: [makeCitation(symbol, url)],
  };
}

// ============================================================================
// Helpers
// ============================================================================

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

function pickInt(v: unknown): number | null {
  const f = pickFloat(v);
  if (f === null) return null;
  return Math.round(f);
}

/** Eastmoney expresses HOLDER_TOTAL_NUMCHANGEH as raw % (e.g. -3.5). */
function pickDecimalFromPct(v: unknown): number | null {
  const f = pickFloat(v);
  if (f === null) return null;
  return f / 100;
}

function deriveTrend(rows: ShareholdersRow[]): ShareholdersOutput['latestTrend'] {
  if (rows.length === 0) return 'unknown';
  const latest = rows[0];
  if (!latest || latest.holderTotalNumChange === null) return 'unknown';
  if (latest.holderTotalNumChange > 0) return 'rising';
  if (latest.holderTotalNumChange < 0) return 'falling';
  return 'flat';
}

function makeCitation(symbol: string, url: string): Citation {
  return {
    title: `东方财富 股东户数 ${symbol}`,
    url,
    sourceType: 'OTHER',
    retrievedAt: new Date().toISOString(),
  };
}

function resolveSourcePriorities(
  profile: MarketProfile | undefined,
  fact: string,
): string[] {
  const fromProfile = profile?.sourcePriorities?.[fact];
  if (fromProfile && fromProfile.length > 0) return fromProfile;
  return ['eastmoney'];
}

export const shareholdersCN = makeShareholdersCN();
