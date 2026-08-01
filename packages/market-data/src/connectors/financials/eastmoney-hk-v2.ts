import { RESEARCH_SCHEMA_VERSION, type ResearchResult } from '../../contracts/result';
import type { ResearchCitation } from '../../contracts/research-citation';
import type { ResearchWarning } from '../../contracts/warning';
import { DecimalStringSchema } from '../../contracts/scalars';
import {
  FinancialsBundleV2Schema,
  type FinancialFact,
  type FinancialsBundleV2,
  type ProviderFinancialsV2Port,
} from '../../ports/financials-v2';
import { parseInstrumentId } from '../../util/instrument-id';
import type { ConnectorRunContext, FetchLike } from '../types';
import { failure as httpFailure, resolveFetch, withTimeout } from '../http';

/**
 * Eastmoney HK F10 connector — v2（structured-first earnings）。
 *
 * 修复 v1（eastmoney-hk.ts）的期间语义问题（§8.3）：
 * - 中期行不再一律标 Q：DATE_TYPE 001=FY / 002=H1 / 003=Q1 / 004=9M；
 * - 财年归属按"财年开始年"：从相邻年报结束日推导 cycleStart
 *   （FYE 3/31 的年报 fiscalYear=2024，即 FY2024/25），不再用 REPORT_DATE 日历年；
 * - interim flow 标 YTD，periodStartOn 为财年开始日；
 * - `periodEndOn` 不再冒充 publishedAt：有 NOTICE_DATE/UPDATE_DATE 才填，
 *   否则留空（不伪造公告时间）；
 * - reporting currency 取 RPT_HKF10_FN_INCOME.CURRENCY_CODE，取不到不默认 HKD，
 *   返回 PARTIAL_DATA（reporting_currency_unknown）。
 *
 * 覆盖字段：revenue/grossProfit/netIncomeAttrib/epsBasic/epsDiluted/
 * totalAssets/totalLiabilities/totalEquity/operatingCashFlow；
 * 未披露的（operatingIncome、FCF 等）保持缺失，不填 0。
 */

const PROVIDER = 'eastmoney-hk-financials-v2';
const BASE_URL = 'https://datacenter.eastmoney.com/securities/api/data/v1/get';
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_YEARS = 5;

const COMMON_HEADERS: Record<string, string> = {
  Referer: 'https://emweb.securities.eastmoney.com/',
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Bourse/0.8',
  Accept: 'application/json, text/plain, */*',
};

type HkDateType = '001' | '002' | '003' | '004';

interface HkMainIndicatorRow {
  REPORT_DATE?: string;
  STD_REPORT_DATE?: string;
  DATE_TYPE_CODE?: string;
  NOTICE_DATE?: string;
  UPDATE_DATE?: string;
  OPERATE_INCOME?: number | string | null;
  GROSS_PROFIT?: number | string | null;
  HOLDER_PROFIT?: number | string | null;
  BASIC_EPS?: number | string | null;
  DILUTED_EPS?: number | string | null;
  TOTAL_ASSETS?: number | string | null;
  TOTAL_LIABILITIES?: number | string | null;
  TOTAL_PARENT_EQUITY?: number | string | null;
  NETCASH_OPERATE?: number | string | null;
  [field: string]: unknown;
}

export interface EastmoneyHkV2Options {
  fetchLike?: FetchLike;
  timeoutMs?: number;
  now?: () => Date;
  pageSize?: number;
}

export function createEastmoneyHkV2FinancialsConnector(
  options: EastmoneyHkV2Options = {},
): ProviderFinancialsV2Port {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = options.now ?? (() => new Date());
  const pageSize = options.pageSize ?? 20;

  return {
    async fetchFinancials(
      input,
      ctx: ConnectorRunContext = {},
    ): Promise<ResearchResult<FinancialsBundleV2 | null>> {
      const retrievedAt = now().toISOString();
      const parsed = parseInstrumentId(input.instrumentId);
      if (!parsed) {
        return failure(retrievedAt, 'INVALID_INSTRUMENT', `Invalid instrumentId: ${input.instrumentId}`);
      }
      if (parsed.market !== 'HK') {
        return failure(
          retrievedAt,
          'UNSUPPORTED_MARKET',
          `eastmoney-hk-financials-v2 only handles HK; got ${parsed.market}`,
        );
      }

      const secucode =
        ctx.resolvedInstrument?.instrumentId === parsed.raw
          ? ctx.resolvedInstrument.providerSymbol
          : toSecucode(parsed.symbol);
      const fetchLike = resolveFetch(ctx, options);

      const mainUrl = queryFor('RPT_HKF10_FN_MAININDICATOR', secucode, pageSize);
      const incomeUrl = queryFor('RPT_HKF10_FN_INCOME', secucode, pageSize);

      let mainRows: HkMainIndicatorRow[];
      let reportingCurrency: string | null;
      try {
        const [main, currency] = await withTimeout(ctx, ctx.timeoutMs ?? timeoutMs, (signal) =>
          Promise.all([
            fetchMainRows(fetchLike, mainUrl, signal),
            fetchReportingCurrency(fetchLike, incomeUrl, signal).catch(() => null),
          ]),
        );
        mainRows = main;
        reportingCurrency = currency;
      } catch (err) {
        const message = (err as Error)?.message ?? String(err);
        return failure(retrievedAt, 'SOURCE_UNAVAILABLE', `Eastmoney HK fetch error: ${message}`, message);
      }

      if (mainRows.length === 0) {
        return {
          schemaVersion: RESEARCH_SCHEMA_VERSION,
          data: null,
          citations: [],
          freshness: [{ provider: PROVIDER, asOf: retrievedAt, retrievedAt, stale: false }],
          warnings: [],
        };
      }
      if (!reportingCurrency) {
        return failure(
          retrievedAt,
          'PARTIAL_DATA',
          'reporting_currency_unknown: RPT_HKF10_FN_INCOME.CURRENCY_CODE missing; refusing to default to HKD',
        );
      }

      const years = input.years ?? DEFAULT_YEARS;
      const snapshotId = `snap-${retrievedAt}-${secucode}`;
      const sourceUrl = `https://emweb.securities.eastmoney.com/PC_HKF10/NewFinanceAnalysis/index?code=${secucode}`;
      const periods = buildPeriods(mainRows, reportingCurrency, years, snapshotId, sourceUrl, retrievedAt);
      if (periods.length === 0) {
        return failure(retrievedAt, 'PARTIAL_DATA', `Eastmoney HK rows present but no usable periods for ${secucode}`);
      }

      const bundle: FinancialsBundleV2 = FinancialsBundleV2Schema.parse({
        schemaVersion: 'financials-v2',
        instrumentId: `${parsed.market}:${parsed.symbol}`,
        provider: PROVIDER,
        sourceNature: 'aggregated_structured',
        qualityTier: 'B',
        sourceUrl,
        retrievedAt,
        snapshotId,
        periods,
      });

      const citation: ResearchCitation = {
        title: `Eastmoney 港股财务摘要: ${secucode}`,
        url: sourceUrl,
        sourceType: 'FILING',
        provider: PROVIDER,
        retrievedAt,
        qualityTier: 'B',
      };

      return {
        schemaVersion: RESEARCH_SCHEMA_VERSION,
        data: bundle,
        citations: [citation],
        freshness: [{ provider: PROVIDER, asOf: retrievedAt, retrievedAt, stale: false }],
        warnings: [],
      };
    },
  };
}

function toSecucode(symbol: string): string {
  const digits = symbol.replace(/\.HK$/i, '').trim();
  const padded = /^\d+$/.test(digits) ? digits.padStart(5, '0') : digits;
  return `${padded}.HK`;
}

function queryFor(reportName: string, secucode: string, pageSize: number): string {
  return (
    `${BASE_URL}?reportName=${reportName}` +
    `&columns=ALL` +
    `&filter=(SECUCODE%3D%22${encodeURIComponent(secucode)}%22)` +
    `&pageNumber=1&pageSize=${pageSize}` +
    `&sortColumns=REPORT_DATE&sortTypes=-1`
  );
}

async function readBody(fetchLike: FetchLike, url: string, signal: AbortSignal): Promise<string> {
  const res = await fetchLike(url, { headers: COMMON_HEADERS, signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text ? await res.text() : JSON.stringify(await res.json());
}

function parseEmRows(body: string): Array<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error('JSON parse failed');
  }
  const root = parsed as {
    success?: boolean;
    code?: number;
    result?: { data?: unknown };
  };
  if (root.code === 9501) {
    throw new Error(`eastmoney HK report config not found (${root.success ?? ''})`);
  }
  const rows = root.result?.data;
  if (!Array.isArray(rows)) return [];
  return rows as Array<Record<string, unknown>>;
}

async function fetchMainRows(
  fetchLike: FetchLike,
  url: string,
  signal: AbortSignal,
): Promise<HkMainIndicatorRow[]> {
  const body = await readBody(fetchLike, url, signal);
  return parseEmRows(body) as HkMainIndicatorRow[];
}

async function fetchReportingCurrency(
  fetchLike: FetchLike,
  url: string,
  signal: AbortSignal,
): Promise<string | null> {
  const rows = parseEmRows(await readBody(fetchLike, url, signal));
  for (const row of rows) {
    const code = row.CURRENCY_CODE;
    if (typeof code === 'string' && /^[A-Z]{3}$/.test(code.trim())) return code.trim();
  }
  return null;
}

// ============================================================================
// Period building（财年归属修复）
// ============================================================================

interface HkRow {
  reportDate: string;
  dateType: HkDateType;
  noticeDate?: string;
  updateDate?: string;
  raw: HkMainIndicatorRow;
}

function buildPeriods(
  rows: HkMainIndicatorRow[],
  currency: string,
  years: number,
  snapshotId: string,
  sourceUrl: string,
  retrievedAt: string,
) {
  const grouped = groupRows(rows);
  const cycles = fiscalCycles(grouped);

  // 按财年开始年倒序取最近 N 年（保持期间完整）。
  const cycleYears = [...new Set(grouped.map((row) => cycles.get(row.reportDate)?.fiscalYear).filter((y): y is number => y !== undefined))].sort((a, b) => b - a);
  const maxYear = cycleYears[0] ?? 0;
  const minYear = maxYear - years + 1;

  const periods = grouped
    .filter((row) => {
      const fiscalYear = cycles.get(row.reportDate)?.fiscalYear;
      return fiscalYear !== undefined && fiscalYear >= minYear;
    })
    .sort((a, b) => (a.reportDate < b.reportDate ? 1 : -1))
    .map((row, index) => {
      const cycle = cycles.get(row.reportDate);
      const periodType = periodTypeOf(row.dateType);
      const facts = buildFacts(row, currency, cycle, snapshotId, sourceUrl, retrievedAt, index);
      return {
        id: `period-${row.reportDate}-${row.dateType}`,
        fiscalYear: cycle?.fiscalYear ?? Number(row.reportDate.slice(0, 4)),
        fiscalPeriodType: periodType,
        ...(cycle?.periodStartOn ? { periodStartOn: cycle.periodStartOn } : {}),
        periodEndOn: row.reportDate,
        ...(row.noticeDate ? { publishedAt: toDateTime(row.noticeDate) } : {}),
        reportingScope: 'consolidated',
        accountingBasis: 'HKFRS',
        revision: { kind: 'original' },
        facts,
      };
    });
  return periods;
}

function groupRows(rows: HkMainIndicatorRow[]): HkRow[] {
  const byKey = new Map<string, HkRow>();
  for (const raw of rows) {
    const reportDate = (raw.REPORT_DATE ?? raw.STD_REPORT_DATE)?.slice(0, 10);
    const dateType = raw.DATE_TYPE_CODE;
    if (!reportDate || !dateType || !['001', '002', '003', '004'].includes(dateType)) continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(reportDate)) continue;
    const key = `${reportDate}|${dateType}`;
    const row: HkRow = {
      reportDate,
      dateType: dateType as HkDateType,
      noticeDate: raw.NOTICE_DATE?.slice(0, 10),
      updateDate: raw.UPDATE_DATE?.slice(0, 10),
      raw,
    };
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, row);
    } else {
      // 重复公告/更正：保留公告日期较新的版本。
      const existingVersion = existing.updateDate ?? existing.noticeDate ?? '';
      const newVersion = row.updateDate ?? row.noticeDate ?? '';
      if (newVersion > existingVersion) byKey.set(key, row);
    }
  }
  return [...byKey.values()];
}

/**
 * 财年周期推断：每个期间归属到"其后最近一份年报"所在的财年；
 * cycleStart 优先级：上一份年报结束日 + 1 天 → 同周期 H1/9M 反推（结束日
 * 减 6/9 个月 + 1 天）→ 自然年 1 月 1 日兜底。
 */
function fiscalCycles(rows: HkRow[]): Map<string, { fiscalYear: number; periodStartOn: string }> {
  const annuals = rows
    .filter((row) => row.dateType === '001')
    .sort((a, b) => (a.reportDate < b.reportDate ? -1 : 1));
  const out = new Map<string, { fiscalYear: number; periodStartOn: string }>();

  const cycleByEnd = new Map<string, HkRow[]>();
  for (const row of rows) {
    const cycleEnd =
      row.dateType === '001'
        ? row
        : annuals.find((annual) => annual.reportDate > row.reportDate);
    const endKey = cycleEnd?.reportDate ?? `${row.reportDate}|none`;
    const group = cycleByEnd.get(endKey) ?? [];
    group.push(row);
    cycleByEnd.set(endKey, group);
  }

  for (const group of cycleByEnd.values()) {
    const cycleEnd = group.find((row) => row.dateType === '001') ?? group[0];
    const prevAnnual = annuals.find((annual) => annual.reportDate < cycleEnd.reportDate) ?? null;
    let periodStartOn: string | null = null;
    if (prevAnnual) {
      periodStartOn = addDays(prevAnnual.reportDate, 1);
    } else {
      const h1 = group.find((row) => row.dateType === '002');
      const nineM = group.find((row) => row.dateType === '004');
      if (h1) periodStartOn = addMonths(h1.reportDate, -6, 1);
      else if (nineM) periodStartOn = addMonths(nineM.reportDate, -9, 1);
    }
    if (!periodStartOn) {
      // 兜底：自然年假设（仅当既无前一年报也无 H1/9M 时）。
      periodStartOn = `${Number(cycleEnd.reportDate.slice(0, 4))}-01-01`;
    }
    const fiscalYear = Number(periodStartOn.slice(0, 4));
    for (const row of group) {
      out.set(row.reportDate, { fiscalYear, periodStartOn });
    }
  }
  return out;
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function addMonths(date: string, months: number, days: number): string {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCMonth(d.getUTCMonth() + months);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function periodTypeOf(dateType: HkDateType): 'FY' | 'H1' | 'Q1' | '9M' {
  const map: Record<HkDateType, 'FY' | 'H1' | 'Q1' | '9M'> = {
    '001': 'FY',
    '002': 'H1',
    '003': 'Q1',
    '004': '9M',
  };
  return map[dateType];
}

function toDateTime(date: string): string {
  return date.length === 10 ? `${date}T00:00:00.000Z` : date;
}

function buildFacts(
  row: HkRow,
  currency: string,
  cycle: { fiscalYear: number; periodStartOn: string } | undefined,
  snapshotId: string,
  sourceUrl: string,
  retrievedAt: string,
  index: number,
) {
  const periodId = `period-${row.reportDate}-${row.dateType}`;
  const isAnnual = row.dateType === '001';
  const facts: FinancialFact[] = [];

  const push = (
    metricCode: FinancialFact['metricCode'],
    value: number | string | null | undefined,
    unit: 'currency' | 'per_share',
    field: string,
  ) => {
    if (value === null || value === undefined) return;
    const decimal = String(value);
    if (!DecimalStringSchema.safeParse(decimal).success) return;
    const isInstant = metricCode.startsWith('total');
    facts.push({
      id: `${periodId}:${metricCode}:${index}`,
      metricCode,
      value: decimal,
      unit,
      currency,
      scale: 1,
      periodKind: isInstant ? 'instant' : 'duration',
      ...(isInstant
        ? {}
        : {
            periodStartOn: cycle?.periodStartOn ?? `${Number(row.reportDate.slice(0, 4))}-01-01`,
            accumulation: isAnnual ? 'FY' : 'YTD',
          }),
      periodEndOn: row.reportDate,
      accountingBasis: 'HKFRS',
      reportingScope: 'consolidated',
      derivation: { kind: 'reported' },
      provenance: {
        provider: PROVIDER,
        sourceNature: 'aggregated_structured',
        qualityTier: 'B',
        sourceUrl,
        sourceField: field,
        ...(row.noticeDate ? { sourceFiledAt: toDateTime(row.noticeDate) } : {}),
        snapshotId,
        retrievedAt,
      },
    });
  };

  push('revenue', row.raw.OPERATE_INCOME, 'currency', 'OPERATE_INCOME');
  push('grossProfit', row.raw.GROSS_PROFIT, 'currency', 'GROSS_PROFIT');
  push('netIncomeAttrib', row.raw.HOLDER_PROFIT, 'currency', 'HOLDER_PROFIT');
  push('epsBasic', row.raw.BASIC_EPS, 'per_share', 'BASIC_EPS');
  push('epsDiluted', row.raw.DILUTED_EPS, 'per_share', 'DILUTED_EPS');
  push('totalAssets', row.raw.TOTAL_ASSETS, 'currency', 'TOTAL_ASSETS');
  push('totalLiabilities', row.raw.TOTAL_LIABILITIES, 'currency', 'TOTAL_LIABILITIES');
  push('totalEquity', row.raw.TOTAL_PARENT_EQUITY, 'currency', 'TOTAL_PARENT_EQUITY');
  push('operatingCashFlow', row.raw.NETCASH_OPERATE, 'currency', 'NETCASH_OPERATE');
  return facts;
}

function failure(
  retrievedAt: string,
  code: ResearchWarning['code'],
  message: string,
  cause?: string,
): ResearchResult<FinancialsBundleV2 | null> {
  return httpFailure<FinancialsBundleV2 | null>(PROVIDER, null, {
    retrievedAt,
    code,
    message,
    ...(cause ? { cause } : {}),
  });
}
