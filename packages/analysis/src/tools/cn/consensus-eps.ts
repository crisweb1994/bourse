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
 * RFC-02 §8.2 — A-share consensus EPS (机构一致预期).
 *
 * Returns sell-side analyst forecast EPS for the next 1-3 forward years.
 * Source: eastmoney's `RPT_WEB_RESPREDICT` datacenter report (one row per
 * stock with YEAR1..4 / EPS1..4 — the sell-side mean forecast EPS). We
 * unpivot the year columns and surface them sorted by year asc.
 *
 * Source priority (per CN_SOURCE_PRIORITIES.consensusEps):
 *   1. eastmoney datacenter (implemented).
 *   2. thsNorthbound (not implemented in RFC-02 Phase 1 — kept for future).
 */

export const ConsensusEpsInputSchema = z.object({
  symbol: z.string().min(1),
  market: z.literal('CN'),
});
export type ConsensusEpsInput = z.infer<typeof ConsensusEpsInputSchema>;

export const ConsensusEpsOutputSchema = z.object({
  forecasts: z.array(
    z.object({
      year: z.number().int(),
      value: z.number(),
    }),
  ),
});
export type ConsensusEpsOutput = z.infer<typeof ConsensusEpsOutputSchema>;

const defaultFetch: CnToolFetchLike = (url, init) =>
  globalThis.fetch(url, init) as Promise<
    ReturnType<CnToolFetchLike> extends Promise<infer T> ? T : never
  >;

export function makeConsensusEpsCN(opts?: {
  fetchImpl?: CnToolFetchLike;
}): ToolDescriptor<ConsensusEpsInput, ConsensusEpsOutput> {
  const fetchImpl = opts?.fetchImpl ?? defaultFetch;
  return {
    name: 'consensusEps',
    description: 'A-share sell-side consensus EPS forecast for forward years.',
    providerInternal: false,
    market: 'CN',
    factField: 'consensusEps',
    inputSchema: ConsensusEpsInputSchema,
    outputSchema: ConsensusEpsOutputSchema,
    async run(input, ctx): Promise<ToolResult<ConsensusEpsOutput>> {
      const startedAt = Date.now();
      const priorities = resolveSourcePriorities(
        ctx.marketProfile,
        'consensusEps',
      );

      const errors: Array<{ source: string; message: string }> = [];
      for (let i = 0; i < priorities.length; i++) {
        const source = priorities[i];
        try {
          const result = await tryFetch(
            source,
            input.symbol,
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
        `consensusEps exhausted sources [${priorities.join(',')}]: ${summary}`,
      );
    },
  };
}

interface FetchResult {
  data: ConsensusEpsOutput;
  citations: Citation[];
}

async function tryFetch(
  source: string,
  symbol: string,
  marketProfile: MarketProfile | undefined,
  fetchImpl: CnToolFetchLike,
  signal?: AbortSignal,
): Promise<FetchResult> {
  if (source === 'eastmoney') {
    return fetchFromEastmoney(symbol, marketProfile, fetchImpl, signal);
  }
  if (source === 'thsNorthbound') {
    throw new Error(
      `thsNorthbound consensusEps not implemented in RFC-02 Phase 1 (future RFC)`,
    );
  }
  throw new Error(`unknown source: ${source}`);
}

async function fetchFromEastmoney(
  symbol: string,
  _marketProfile: MarketProfile | undefined,
  fetchImpl: CnToolFetchLike,
  signal?: AbortSignal,
): Promise<FetchResult> {
  const code = symbol.split('.')[0];
  // eastmoney retired RPT_RES_CONFORECASTPREDATA (verified 2026 → HTTP
  // "报表配置不存在"). RPT_WEB_RESPREDICT is the live replacement: ONE row
  // per stock with YEAR1..4 + EPS1..4 (sell-side mean forecast EPS).
  const url =
    `https://datacenter-web.eastmoney.com/api/data/v1/get?` +
    `reportName=RPT_WEB_RESPREDICT` +
    `&columns=SECUCODE,SECURITY_CODE,YEAR1,YEAR2,YEAR3,YEAR4,EPS1,EPS2,EPS3,EPS4` +
    `&pageNumber=1&pageSize=1` +
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
  if (!Array.isArray(rows) || rows.length === 0) {
    // code 9201 / empty = no analyst coverage for this stock (valid for small
    // caps). Return empty rather than a hard connector_error.
    return {
      data: { forecasts: [] },
      citations: [
        {
          title: `东方财富 一致预期 ${symbol}`,
          url,
          sourceType: 'OTHER',
          retrievedAt: new Date().toISOString(),
        },
      ],
    };
  }

  // RPT_WEB_RESPREDICT pivots the forecast years into YEAR1..4 / EPS1..4
  // columns on a single row — unpivot into {year, value} pairs.
  const o = rows[0] as Record<string, unknown>;
  const forecasts: ConsensusEpsOutput['forecasts'] = [];
  for (let i = 1; i <= 4; i++) {
    const year = pickInt(o[`YEAR${i}`]);
    const value = pickFloat(o[`EPS${i}`]);
    if (year === null || value === null) continue;
    forecasts.push({ year, value });
  }
  if (forecasts.length === 0) {
    throw new Error(`eastmoney: no parseable forecast rows`);
  }
  forecasts.sort((a, b) => a.year - b.year);

  return {
    data: { forecasts },
    citations: [
      {
        title: `东方财富 一致预期 ${symbol}`,
        url,
        sourceType: 'OTHER',
        retrievedAt: new Date().toISOString(),
      },
    ],
  };
}

// ===== Helpers =====

function pickInt(v: unknown): number | null {
  if (typeof v === 'number' && Number.isInteger(v)) return v;
  if (typeof v === 'string') {
    const n = parseInt(v, 10);
    if (Number.isFinite(n)) return n;
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
  return ['eastmoney', 'thsNorthbound'];
}

export const consensusEpsCN = makeConsensusEpsCN();
