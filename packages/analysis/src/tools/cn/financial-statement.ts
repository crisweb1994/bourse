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
 * RFC-02 §8.2 — A-share financial statement summary.
 *
 * Returns the last ~8 quarterly reports (newest first) with the core
 * income / cash flow lines a fundamentals dimension needs:
 *   - revenue (营业总收入), 元
 *   - netIncome (归母净利), 元
 *   - netIncomeExNRR (扣非归母净利), 元
 *   - eps (基本每股收益)
 *   - operatingCashFlow (经营性现金流量净额), 元
 *
 * Source priority (per CN_SOURCE_PRIORITIES.financialStatement):
 *   1. eastmoney datacenter — JSON API, fast, no auth.
 *   2. cninfo — would require PDF parsing of quarterly disclosures; not
 *      implemented in RFC-02 Phase 1. The source is kept in the chain so
 *      a future RFC (with a Jina Reader / pdf-parse adapter) can drop in
 *      the implementation without touching profile config.
 *
 * On both sources failing, throw — the EvidencePack builder records the
 * field as missing in `dataAvailability.missing` (CLAUDE.md §3 — no hallucination).
 */

export const FinancialStatementInputSchema = z.object({
  symbol: z.string().min(1),
  market: z.literal('CN'),
  /** Max quarters to return, newest first. Default 8, hard cap 20. */
  limit: z.number().int().positive().max(20).optional(),
});
export type FinancialStatementInput = z.infer<
  typeof FinancialStatementInputSchema
>;

const PeriodTypeEnum = z.enum([
  'annual',     // 年报
  'q1',         // 一季报
  'semi',       // 中报
  'q3',         // 三季报
  'other',
]);

const ReportRow = z.object({
  reportDate: z.string().datetime(),
  periodType: PeriodTypeEnum,
  revenue: z.number().nullable(),
  netIncome: z.number().nullable(),
  netIncomeExNRR: z.number().nullable(),
  eps: z.number().nullable(),
  operatingCashFlow: z.number().nullable(),
});

export const FinancialStatementOutputSchema = z.object({
  reports: z.array(ReportRow),
});
export type FinancialStatementOutput = z.infer<
  typeof FinancialStatementOutputSchema
>;

const defaultFetch: CnToolFetchLike = (url, init) =>
  globalThis.fetch(url, init) as Promise<
    ReturnType<CnToolFetchLike> extends Promise<infer T> ? T : never
  >;

export function makeFinancialStatementCN(opts?: {
  fetchImpl?: CnToolFetchLike;
}): ToolDescriptor<FinancialStatementInput, FinancialStatementOutput> {
  const fetchImpl = opts?.fetchImpl ?? defaultFetch;
  return {
    name: 'financialStatement',
    description:
      'A-share quarterly financial statement summary (revenue / netIncome / EPS / OCF).',
    providerInternal: false,
    market: 'CN',
    factField: 'financialStatement',
    inputSchema: FinancialStatementInputSchema,
    outputSchema: FinancialStatementOutputSchema,
    async run(input, ctx): Promise<ToolResult<FinancialStatementOutput>> {
      const startedAt = Date.now();
      const limit = input.limit ?? 8;
      const priorities = resolveSourcePriorities(
        ctx.marketProfile,
        'financialStatement',
      );

      const errors: Array<{ source: string; message: string }> = [];
      for (let i = 0; i < priorities.length; i++) {
        const source = priorities[i];
        try {
          const result = await tryFetch(
            source,
            input.symbol,
            limit,
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

      const summary = errors
        .map((e) => `${e.source}: ${e.message}`)
        .join('; ');
      throw new Error(
        `financialStatement exhausted sources [${priorities.join(',')}]: ${summary}`,
      );
    },
  };
}

// ===== Source-specific fetchers =====

interface FsFetchResult {
  data: FinancialStatementOutput;
  citations: Citation[];
}

async function tryFetch(
  source: string,
  symbol: string,
  limit: number,
  marketProfile: MarketProfile | undefined,
  fetchImpl: CnToolFetchLike,
  signal?: AbortSignal,
): Promise<FsFetchResult> {
  if (source === 'eastmoney') {
    return fetchFromEastmoney(symbol, limit, marketProfile, fetchImpl, signal);
  }
  if (source === 'cninfo') {
    // Phase 1 deliberately skips PDF parsing; throw a clear sentinel so the
    // builder's missing-reason makes the gap obvious.
    throw new Error(
      `cninfo PDF parsing not implemented in RFC-02 Phase 1 (future RFC)`,
    );
  }
  throw new Error(`unknown source: ${source}`);
}

/**
 * Eastmoney datacenter `RPT_LICO_FN_CPD` returns quarterly fundamentals.
 * Field names (verified 2026-Q1):
 *   - SECUCODE / SECURITY_NAME_ABBR
 *   - REPORT_DATE (string 'YYYY-MM-DD HH:MM:SS')
 *   - REPORT_TYPE ('年报' / '一季报' / '中报' / '三季报')
 *   - TOTAL_OPERATE_INCOME (元)
 *   - PARENT_NETPROFIT (元)
 *   - DEDUCT_PARENT_NETPROFIT (元)
 *   - BASIC_EPS (元/股)
 *   - NETCASH_OPERATE (元)
 *
 * Schema-loose extraction: each row's numeric fields default to null when
 * absent/unparseable rather than dropping the entire row.
 */
async function fetchFromEastmoney(
  symbol: string,
  limit: number,
  _marketProfile: MarketProfile | undefined,
  fetchImpl: CnToolFetchLike,
  signal?: AbortSignal,
): Promise<FsFetchResult> {
  const code = symbol.split('.')[0];
  const columns = [
    'SECUCODE',
    'SECURITY_NAME_ABBR',
    'REPORT_DATE',
    'REPORT_TYPE',
    'TOTAL_OPERATE_INCOME',
    'PARENT_NETPROFIT',
    'DEDUCT_PARENT_NETPROFIT',
    'BASIC_EPS',
    'NETCASH_OPERATE',
  ].join(',');
  const url =
    `https://datacenter.eastmoney.com/securities/api/data/v1/get?` +
    `reportName=RPT_LICO_FN_CPD` +
    `&columns=${columns}` +
    `&pageNumber=1&pageSize=${Math.min(limit, 20)}` +
    `&sortColumns=REPORT_DATE&sortTypes=-1` +
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
    // code 9201 / null result = no financial rows for this stock. Return empty
    // rather than a hard connector_error.
    return {
      data: { reports: [] },
      citations: [
        {
          title: `东方财富 财务数据 ${symbol}`,
          url,
          sourceType: 'OTHER',
          retrievedAt: new Date().toISOString(),
        },
      ],
    };
  }

  const reports = rows
    .slice(0, limit)
    .map((row) => parseEastmoneyRow(row))
    .filter((r): r is FinancialStatementOutput['reports'][number] => r !== null);

  if (reports.length === 0) {
    throw new Error(`eastmoney: no parseable rows`);
  }

  return {
    data: { reports },
    citations: [
      {
        title: `东方财富 财务数据 ${symbol}`,
        url,
        sourceType: 'OTHER',
        retrievedAt: new Date().toISOString(),
      },
    ],
  };
}

function parseEastmoneyRow(
  raw: unknown,
): FinancialStatementOutput['reports'][number] | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const dateStr =
    typeof o.REPORT_DATE === 'string' ? o.REPORT_DATE.split(' ')[0] : null;
  if (!dateStr) return null;
  const t = Date.parse(dateStr);
  if (!Number.isFinite(t)) return null;
  const reportType =
    typeof o.REPORT_TYPE === 'string' ? o.REPORT_TYPE : '';
  return {
    reportDate: new Date(t).toISOString(),
    periodType: classifyReportType(reportType),
    revenue: pickNumber(o.TOTAL_OPERATE_INCOME),
    netIncome: pickNumber(o.PARENT_NETPROFIT),
    netIncomeExNRR: pickNumber(o.DEDUCT_PARENT_NETPROFIT),
    eps: pickNumber(o.BASIC_EPS),
    operatingCashFlow: pickNumber(o.NETCASH_OPERATE),
  };
}

function classifyReportType(raw: string): z.infer<typeof PeriodTypeEnum> {
  if (/年报|年度/.test(raw)) return 'annual';
  if (/一季报|一季度/.test(raw)) return 'q1';
  if (/中报|半年/.test(raw)) return 'semi';
  if (/三季报|三季度/.test(raw)) return 'q3';
  return 'other';
}

function pickNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = parseFloat(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

// ===== Helpers =====

function resolveSourcePriorities(
  profile: MarketProfile | undefined,
  fact: string,
): string[] {
  const fromProfile = profile?.sourcePriorities?.[fact];
  if (fromProfile && fromProfile.length > 0) return fromProfile;
  return ['eastmoney', 'cninfo'];
}

// Default-registered descriptor.
export const financialStatementCN = makeFinancialStatementCN();
export { classifyReportType };
