import { z } from 'zod';
import {
  SCREENING_METRIC_UNITS,
  ScreeningQuerySchema,
  type EquityScreenerSnapshot,
  type ScreenerMetric,
  type ScreeningCandidateRow,
  type ScreeningCondition,
  type ScreeningMetricCell,
  type ScreeningQuery,
} from '@bourse/shared-types';
import type { SourceFailureCode } from '../../contracts/errors';
import type { SourceResult } from '../../contracts/source-result';
import type { ResearchWarning } from '../../contracts/warning';
import type {
  EquityScreenerDescriptor,
  EquityScreenerPort,
} from '../../ports/equity-screener';
import { CN_BROWSER_HEADERS, inferExchange } from '../cn-common';
import { resolveFetch, withTimeout } from '../http';
import type { ConnectorRunContext, FetchLike } from '../types';

const SOURCE_ID = 'eastmoney-cn-screener';
const ENDPOINT = 'https://push2delay.eastmoney.com/api/qt/clist/get';
const PAGE_SIZE = 5_000;
const MAX_PAGES = 100;
const DEFAULT_TIMEOUT_MS = 12_000;
const RESULT_LIMIT = 200;
const A_SHARE_UNIVERSE = [
  'm:0+t:6',
  'm:0+t:80',
  'm:1+t:2',
  'm:1+t:23',
  'm:0+t:81+s:2048',
].join(',');
const EASTMONEY_HEADERS = {
  ...CN_BROWSER_HEADERS,
  Referer: 'https://quote.eastmoney.com/center/gridlist.html',
};

const SUPPORTED_METRICS = [
  'MARKET_CAP',
  'PE_TTM',
  'PB',
  'PRICE',
  'CHANGE_PCT',
  'TURNOVER_RATE',
] as const satisfies readonly ScreenerMetric[];

const SUPPORTED_METRIC_SET = new Set<ScreenerMetric>(SUPPORTED_METRICS);

const DESCRIPTOR: EquityScreenerDescriptor = {
  market: 'CN',
  metrics: SUPPORTED_METRICS.map((metric) => ({
    metric,
    operators: ['GTE', 'LTE', 'BETWEEN'],
  })),
  sortableMetrics: [...SUPPORTED_METRICS],
  delay: 'delayed',
  universeLabel: '沪深京活跃 A 股普通股',
  universeRules: [
    '仅包含东方财富沪深京 A 股列表中的证券，不包含 ETF、基金和指数。',
    '缺少有效证券代码、交易所或最新价的行不进入活跃股票池。',
    '任一硬筛选条件缺少数据时，该证券不命中条件。',
  ],
};

const EastmoneyRowSchema = z
  .object({
    f2: z.unknown(),
    f3: z.unknown(),
    f8: z.unknown(),
    f9: z.unknown(),
    f12: z.string().regex(/^\d{6}$/),
    f13: z.union([z.number(), z.string()]),
    f14: z.string().min(1),
    f20: z.unknown(),
    f23: z.unknown(),
    f115: z.unknown(),
    f124: z.union([z.number(), z.string()]).optional().catch(undefined),
  })
  .passthrough();

const EastmoneyPageSchema = z
  .object({
    data: z
      .object({
        total: z.number().int().nonnegative(),
        diff: z.array(EastmoneyRowSchema),
      })
      .nullable(),
  })
  .passthrough();

type EastmoneyRow = z.infer<typeof EastmoneyRowSchema>;

interface EastmoneyEquityScreenerOptions {
  fetchLike?: FetchLike;
  timeoutMs?: number;
}

export function createEastmoneyEquityScreenerConnector(
  options: EastmoneyEquityScreenerOptions = {},
): EquityScreenerPort {
  return {
    async describe(market) {
      if (market !== 'CN') {
        return failed(
          'UNSUPPORTED_MARKET',
          'UNSUPPORTED_MARKET',
          `Eastmoney equity screener only supports CN; got ${market}.`,
        );
      }
      return ok(DESCRIPTOR);
    },

    async screen(input, ctx: ConnectorRunContext = {}) {
      const parsed = ScreeningQuerySchema.safeParse(input);
      if (!parsed.success) {
        return failed(
          'UNSUPPORTED_REQUEST',
          'INVALID_PAYLOAD',
          'Equity screening query is outside the canonical schema.',
        );
      }
      const query = parsed.data;
      if (query.market !== 'CN') {
        return failed(
          'UNSUPPORTED_MARKET',
          'UNSUPPORTED_MARKET',
          `Eastmoney equity screener only supports CN; got ${query.market}.`,
        );
      }
      const unsupported = [
        ...query.conditions.map((condition) => condition.metric),
        query.sort.metric,
      ].filter((metric) => !SUPPORTED_METRIC_SET.has(metric));
      if (unsupported.length > 0) {
        return failed(
          'UNSUPPORTED_REQUEST',
          'INVALID_PAYLOAD',
          `Eastmoney equity screener does not support: ${[...new Set(unsupported)].join(', ')}.`,
        );
      }

      const retrievedAt = new Date().toISOString();
      const fetchLike = resolveFetch(ctx, options);
      try {
        return await withTimeout(
          ctx,
          ctx.timeoutMs ?? options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          async (signal) => {
            const universe = await fetchUniverse(fetchLike, signal);
            if (!universe.ok) {
              return failed(universe.errorCode, universe.warningCode, universe.message, retrievedAt);
            }

            const providerAsOf = latestProviderAsOf(universe.rows.values());
            if (!providerAsOf) {
              return failed(
                'VALIDATION_FAILED',
                'INVALID_PAYLOAD',
                'Eastmoney clist returned no valid provider timestamps.',
                retrievedAt,
              );
            }

            const rows = [...universe.rows.values()]
              .map((row) => normalizeRow(row, providerTimestamp(row.f124)))
              .filter((row): row is ScreeningCandidateRow => row !== null);
            if (rows.length === 0) {
              return failed(
                'VALIDATION_FAILED',
                'INVALID_PAYLOAD',
                'Eastmoney returned no usable active A-share rows.',
                retrievedAt,
              );
            }

            let remaining = rows;
            const conditionCounts: number[] = [];
            for (const condition of query.conditions) {
              remaining = remaining.filter((row) => matchesCondition(row, condition));
              conditionCounts.push(remaining.length);
            }

            const sorted = [...remaining].sort(candidateComparator(query));
            const matchedConditionIndexes = query.conditions.map((_, index) => index);
            const snapshot: EquityScreenerSnapshot = {
              universeCount: rows.length,
              matchedCount: sorted.length,
              providerAsOf,
              complete: universe.complete,
              truncated: sorted.length > RESULT_LIMIT,
              conditionCounts,
              items: sorted.slice(0, RESULT_LIMIT).map((row) => ({
                ...row,
                matchedConditionIndexes,
              })),
            };
            return ok(snapshot, { asOf: providerAsOf, retrievedAt }, universe.warnings);
          },
        );
      } catch (error) {
        const aborted = ctx.signal?.aborted || (error as { name?: string }).name === 'AbortError';
        return failed(
          aborted ? 'ABORTED' : 'SOURCE_UNAVAILABLE',
          'SOURCE_UNAVAILABLE',
          aborted
            ? 'Eastmoney equity screening request was aborted.'
            : `Eastmoney equity screening request failed: ${errorMessage(error)}.`,
          retrievedAt,
        );
      }
    },
  };
}

type UniverseFetchResult =
  | {
      ok: true;
      rows: Map<string, EastmoneyRow>;
      complete: boolean;
      warnings: ResearchWarning[];
    }
  | {
      ok: false;
      errorCode: SourceFailureCode;
      warningCode: ResearchWarning['code'];
      message: string;
    };

async function fetchUniverse(
  fetchLike: FetchLike,
  signal: AbortSignal,
): Promise<UniverseFetchResult> {
  const rows = new Map<string, EastmoneyRow>();
  let expectedTotal: number | undefined;

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    let response: Awaited<ReturnType<FetchLike>>;
    try {
      response = await fetchLike(buildUrl(page), {
        headers: EASTMONEY_HEADERS,
        signal,
      });
    } catch (error) {
      if (signal.aborted) throw error;
      return incompleteOrFailed(
        rows,
        'SOURCE_UNAVAILABLE',
        'SOURCE_UNAVAILABLE',
        `Eastmoney clist page ${page} failed: ${errorMessage(error)}.`,
      );
    }
    if (!response.ok) {
      return incompleteOrFailed(
        rows,
        response.status === 429 ? 'RATE_LIMITED' : 'SOURCE_UNAVAILABLE',
        response.status === 429 ? 'RATE_LIMITED' : 'SOURCE_UNAVAILABLE',
        `Eastmoney clist page ${page} returned HTTP ${response.status}.`,
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      return incompleteOrFailed(
        rows,
        'VALIDATION_FAILED',
        'INVALID_PAYLOAD',
        `Eastmoney clist page ${page} is not valid JSON: ${errorMessage(error)}.`,
      );
    }
    const parsed = EastmoneyPageSchema.safeParse(payload);
    if (!parsed.success || !parsed.data.data) {
      return incompleteOrFailed(
        rows,
        'VALIDATION_FAILED',
        'INVALID_PAYLOAD',
        `Eastmoney clist page ${page} is outside the expected schema.`,
      );
    }
    if (parsed.data.data.total === 0) {
      return {
        ok: false,
        errorCode: 'VALIDATION_FAILED',
        warningCode: 'INVALID_PAYLOAD',
        message: 'Eastmoney clist reported an empty A-share universe.',
      };
    }

    expectedTotal = Math.max(expectedTotal ?? 0, parsed.data.data.total);
    for (const row of parsed.data.data.diff) rows.set(row.f12, row);
    if (rows.size >= expectedTotal) {
      return { ok: true, rows, complete: true, warnings: [] };
    }
    if (parsed.data.data.diff.length === 0) {
      return incompleteOrFailed(
        rows,
        'VALIDATION_FAILED',
        'INVALID_PAYLOAD',
        `Eastmoney clist ended after ${rows.size} of ${expectedTotal} rows.`,
      );
    }
  }

  return incompleteOrFailed(
    rows,
    'VALIDATION_FAILED',
    'INVALID_PAYLOAD',
    `Eastmoney clist exceeded ${MAX_PAGES} pages before the universe was complete.`,
  );
}

function incompleteOrFailed(
  rows: Map<string, EastmoneyRow>,
  errorCode: SourceFailureCode,
  warningCode: ResearchWarning['code'],
  message: string,
): UniverseFetchResult {
  if (rows.size === 0) return { ok: false, errorCode, warningCode, message };
  return {
    ok: true,
    rows,
    complete: false,
    warnings: [{ code: 'PARTIAL_COVERAGE', message, provider: SOURCE_ID }],
  };
}

function buildUrl(page: number): string {
  const url = new URL(ENDPOINT);
  url.searchParams.set('pn', String(page));
  url.searchParams.set('pz', String(PAGE_SIZE));
  url.searchParams.set('po', '1');
  url.searchParams.set('np', '1');
  url.searchParams.set('fltt', '2');
  url.searchParams.set('invt', '2');
  url.searchParams.set('fid', 'f20');
  url.searchParams.set('fs', A_SHARE_UNIVERSE);
  url.searchParams.set('fields', 'f2,f3,f8,f9,f12,f13,f14,f20,f23,f115,f124');
  return url.toString();
}

function normalizeRow(
  row: EastmoneyRow,
  asOf: string | null,
): ScreeningCandidateRow | null {
  const exchange = inferExchange(row.f12);
  const price = numberValue(row.f2);
  if (!exchange || price === null || price <= 0) return null;

  const pe = numberValue(row.f115);
  const metrics: Record<ScreenerMetric, ScreeningMetricCell> = {
    MARKET_CAP: cell('MARKET_CAP', numberValue(row.f20), asOf),
    NET_INCOME_TTM: cell('NET_INCOME_TTM', null, asOf),
    PE_TTM: pe !== null && pe > 0
      ? cell('PE_TTM', pe, asOf)
      : {
          status: 'NOT_APPLICABLE',
          value: 'NM',
          unit: 'RATIO',
          sourceId: SOURCE_ID,
          asOf,
          estimated: false,
        },
    PB: cell('PB', numberValue(row.f23), asOf),
    REVENUE_GROWTH_YOY: cell('REVENUE_GROWTH_YOY', null, asOf),
    PRICE: cell('PRICE', price, asOf),
    CHANGE_PCT: cell('CHANGE_PCT', percentageValue(row.f3), asOf),
    TURNOVER_RATE: cell('TURNOVER_RATE', percentageValue(row.f8), asOf),
  };

  return {
    identityKey: `CN:${row.f12}`,
    symbol: row.f12,
    name: row.f14.trim() || null,
    exchange: exchange === 'SS' ? 'SSE' : exchange === 'SZ' ? 'SZSE' : 'BSE',
    currency: 'CNY',
    metrics,
    matchedConditionIndexes: [],
  };
}

function cell(
  metric: ScreenerMetric,
  value: number | null,
  asOf: string | null,
): ScreeningMetricCell {
  return {
    status: value === null ? 'MISSING' : 'PRESENT',
    value,
    unit: SCREENING_METRIC_UNITS[metric],
    sourceId: SOURCE_ID,
    asOf,
    estimated: false,
  };
}

function numberValue(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || value.trim() === '' || value.trim() === '-') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function percentageValue(value: unknown): number | null {
  const percentagePoints = numberValue(value);
  return percentagePoints === null ? null : percentagePoints / 100;
}

function providerTimestamp(value: unknown): string | null {
  const seconds = numberValue(value);
  if (seconds === null || !Number.isInteger(seconds) || seconds <= 0) return null;
  const date = new Date(seconds * 1_000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function latestProviderAsOf(rows: Iterable<EastmoneyRow>): string | null {
  let latest: string | null = null;
  for (const row of rows) {
    const candidate = providerTimestamp(row.f124);
    if (candidate && (!latest || candidate > latest)) latest = candidate;
  }
  return latest;
}

function matchesCondition(
  row: ScreeningCandidateRow,
  condition: ScreeningCondition,
): boolean {
  const candidate = row.metrics[condition.metric];
  if (candidate?.status !== 'PRESENT' || typeof candidate.value !== 'number') return false;
  if (condition.operator === 'BETWEEN') {
    return candidate.value >= condition.min && candidate.value <= condition.max;
  }
  if (condition.operator === 'GTE') return candidate.value >= condition.value;
  return candidate.value <= condition.value;
}

function candidateComparator(query: ScreeningQuery) {
  const direction = query.sort.direction === 'ASC' ? 1 : -1;
  return (left: ScreeningCandidateRow, right: ScreeningCandidateRow): number => {
    const leftValue = numericMetric(left, query.sort.metric);
    const rightValue = numericMetric(right, query.sort.metric);
    if (leftValue === null && rightValue === null) return left.symbol.localeCompare(right.symbol);
    if (leftValue === null) return 1;
    if (rightValue === null) return -1;
    return direction * (leftValue - rightValue) || left.symbol.localeCompare(right.symbol);
  };
}

function numericMetric(row: ScreeningCandidateRow, metric: ScreenerMetric): number | null {
  const value = row.metrics[metric]?.value;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function ok<T>(
  data: T,
  timing?: { asOf: string; retrievedAt: string },
  warnings: ResearchWarning[] = [],
): SourceResult<T> {
  return {
    status: 'ok',
    data,
    sourceId: SOURCE_ID,
    citations: timing
      ? [{
          title: '东方财富沪深京 A 股行情列表',
          url: 'https://quote.eastmoney.com/center/gridlist.html#hs_a_board',
          sourceType: 'PRICE',
          provider: SOURCE_ID,
          retrievedAt: timing.retrievedAt,
          qualityTier: 'B',
        }]
      : [],
    freshness: timing
      ? [{
          provider: SOURCE_ID,
          asOf: timing.asOf,
          retrievedAt: timing.retrievedAt,
          stale: false,
        }]
      : [],
    warnings,
  };
}

function failed<T>(
  errorCode: SourceFailureCode,
  warningCode: ResearchWarning['code'],
  message: string,
  asOf = new Date().toISOString(),
): SourceResult<T> {
  return {
    status: 'failed',
    data: null,
    sourceId: SOURCE_ID,
    citations: [],
    freshness: [{ provider: SOURCE_ID, asOf, retrievedAt: asOf, stale: true, reason: message }],
    warnings: [{ code: warningCode, message, provider: SOURCE_ID }],
    error: { code: errorCode, message },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const EASTMONEY_SCREENER_METRICS = SUPPORTED_METRICS;
