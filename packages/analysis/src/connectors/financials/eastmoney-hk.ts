import { RESEARCH_SCHEMA_VERSION, type ResearchResult } from '../../contracts/result';
import type { ResearchCitation } from '../../contracts/research-citation';
import type { ResearchWarning } from '../../contracts/warning';
import type {
  BalanceSheet,
  CashFlow,
  FinancialsBundle,
  FinancialsInput,
  FinancialsLineItem,
  FinancialsPeriodEntry,
  FinancialsPort,
  IncomeStatement,
} from '../../ports/financials';
import { parseInstrumentId } from '../../util/instrument-id';
import type { ConnectorRunContext, FetchLike } from '../types';
import { failure as httpFailure, resolveFetch, withTimeout } from '../http';

/**
 * RFC financials Phase 3 — Eastmoney datacenter HK F10 connector.
 *
 * Unlike the CN path (3 narrow statement reports), HK F10 exposes one WIDE
 * report — `RPT_HKF10_FN_MAININDICATOR` — that carries income + balance +
 * cashflow headline figures and the headline ratios in a single row per
 * reporting period.
 *
 *   GET https://datacenter.eastmoney.com/securities/api/data/v1/get
 *     ?reportName=RPT_HKF10_FN_MAININDICATOR&columns=ALL&pageSize=20
 *     &sortColumns=REPORT_DATE&sortTypes=-1
 *     &filter=(SECUCODE="00700.HK")        ← 5-digit zero-padded code + ".HK"
 *
 * Each row = one period (DATE_TYPE_CODE 001=年报/FY, 002=中报, 003=一季报,
 * 004=三季报). Values are in BASE units of the reporting currency.
 *
 * Reporting currency (verified live 2026-05):
 *   - MAININDICATOR.CURRENCY is ALWAYS "HKD" (the *trading* currency) — it does
 *     NOT reflect the reporting currency. Tencent (00700) reports in RMB but
 *     MAININDICATOR.CURRENCY says "HKD".
 *   - The real reporting currency lives on RPT_HKF10_FN_INCOME.CURRENCY_CODE
 *     (CNY for Tencent/China Mobile, USD for HSBC/AIA). We fetch INCOME once,
 *     in parallel, purely to read CURRENCY_CODE. If it's unavailable we default
 *     to HKD and emit a warning.
 *
 * Period semantics — HK interim reports (002/003/004) are CUMULATIVE within a
 * fiscal year (like CN). We do NOT derive standalone quarters or TTM here: the
 * cumulative shape can't feed the shared `deriveTTM` helper (which expects
 * standalone Q's), and inventing standalone math wasn't in scope. Annual
 * (001) rows are clean full-year figures; interim rows are emitted as `Q`
 * (cumulative) so downstream still sees latest-available fundamentals.
 *
 * Failure semantics (verified live):
 *   - Non-HK instrumentId → UNSUPPORTED_MARKET (null data)
 *   - HTTP failure → SOURCE_UNAVAILABLE (null data)
 *   - code 9501 ("报表配置不存在") → throw (config bug, not a data gap)
 *   - code 9201 ("返回数据为空") / non-array result → null data (delisted /
 *     no HK F10 coverage — valid, common for small caps), NOT a throw
 */

const PROVIDER = 'eastmoney-hk-financials';
const BASE_URL = 'https://datacenter.eastmoney.com/securities/api/data/v1/get';
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_YEARS = 5;
const DEFAULT_CURRENCY = 'HKD';

const COMMON_HEADERS: Record<string, string> = {
  Referer: 'https://emweb.securities.eastmoney.com/',
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Bourse/0.8',
  Accept: 'application/json, text/plain, */*',
};

/** Eastmoney HK MAININDICATOR row — only the columns we read. */
interface HkMainIndicatorRow {
  REPORT_DATE?: string; // 'YYYY-MM-DD HH:mm:ss'
  STD_REPORT_DATE?: string;
  DATE_TYPE_CODE?: string; // '001' = annual; else interim
  REPORT_TYPE?: string;
  OPERATE_INCOME?: number | string | null;
  GROSS_PROFIT?: number | string | null;
  HOLDER_PROFIT?: number | string | null;
  BASIC_EPS?: number | string | null;
  DILUTED_EPS?: number | string | null;
  TOTAL_ASSETS?: number | string | null;
  TOTAL_LIABILITIES?: number | string | null;
  TOTAL_PARENT_EQUITY?: number | string | null;
  NETCASH_OPERATE?: number | string | null;
  NETCASH_INVEST?: number | string | null;
  NETCASH_FINANCE?: number | string | null;
  [field: string]: unknown;
}

/** Thrown for code 9501 — surfaces as SOURCE_UNAVAILABLE (report-config bug). */
class ReportConfigNotFoundError extends Error {}

export interface EastmoneyHkFinancialsOptions {
  fetchLike?: FetchLike;
  timeoutMs?: number;
  now?: () => Date;
  /** Page size; ~20 covers 5 years of mixed annual + interim rows. */
  pageSize?: number;
}

export function createEastmoneyHkFinancialsConnector(
  options: EastmoneyHkFinancialsOptions = {},
): FinancialsPort {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = options.now ?? (() => new Date());
  const pageSize = options.pageSize ?? 20;

  return {
    async fetchFinancials(
      input: FinancialsInput,
      ctx: ConnectorRunContext = {},
    ): Promise<ResearchResult<FinancialsBundle | null>> {
      const retrievedAt = now().toISOString();
      const parsed = parseInstrumentId(input.instrumentId);
      if (!parsed) {
        return failure(retrievedAt, 'INVALID_INSTRUMENT', `Invalid instrumentId: ${input.instrumentId}`);
      }
      if (parsed.market !== 'HK') {
        return failure(
          retrievedAt,
          'UNSUPPORTED_MARKET',
          `eastmoney-hk-financials only handles HK; got ${parsed.market}`,
        );
      }

      const secucode = toSecucode(parsed.symbol);
      const fetchLike = resolveFetch(ctx, options);

      const mainUrl = queryFor('RPT_HKF10_FN_MAININDICATOR', secucode, pageSize);
      const incomeUrl = queryFor('RPT_HKF10_FN_INCOME', secucode, pageSize);

      let mainRows: HkMainIndicatorRow[];
      let reportingCurrency: string | null;
      try {
        // Fan-out: MAININDICATOR (bundle data) + INCOME (currency only) under
        // one timeout. INCOME failure must not sink the whole bundle — its only
        // job is the reporting currency, which we can default + warn on.
        const [main, currency] = await withTimeout(ctx, timeoutMs, (signal) =>
          Promise.all([
            fetchMainRows(fetchLike, mainUrl, signal),
            fetchReportingCurrency(fetchLike, incomeUrl, signal).catch(() => null),
          ]),
        );
        mainRows = main;
        reportingCurrency = currency;
      } catch (err) {
        if (err instanceof ReportConfigNotFoundError) {
          return failure(retrievedAt, 'SOURCE_UNAVAILABLE', err.message, err.message);
        }
        const message = (err as Error)?.message ?? String(err);
        return failure(retrievedAt, 'SOURCE_UNAVAILABLE', `Eastmoney HK fetch error: ${message}`, message);
      }

      // 9201 / non-array → no HK F10 coverage. Valid + common for small caps;
      // return a null bundle (not a throw, not a failure envelope warning that
      // implies the source broke).
      if (mainRows.length === 0) {
        return {
          schemaVersion: RESEARCH_SCHEMA_VERSION,
          data: null,
          citations: [],
          freshness: [{ provider: PROVIDER, asOf: retrievedAt, retrievedAt, stale: false }],
          warnings: [],
        };
      }

      const warnings: ResearchWarning[] = [];
      const currency = reportingCurrency ?? DEFAULT_CURRENCY;
      if (!reportingCurrency) {
        warnings.push({
          code: 'PARTIAL_DATA',
          message: `HK reporting currency unavailable (RPT_HKF10_FN_INCOME.CURRENCY_CODE missing); defaulted to ${DEFAULT_CURRENCY}`,
          provider: PROVIDER,
        });
      }

      const years = input.years ?? DEFAULT_YEARS;
      const periods = buildPeriods(mainRows, currency, years);

      if (periods.length === 0) {
        return failure(retrievedAt, 'PARTIAL_DATA', `Eastmoney HK rows present but no usable periods for ${secucode}`);
      }

      // Provenance: stable human-readable F10 财务报表 page (sourceUrl ===
      // citation.url so downstream can recover qualityTier by URL).
      const sourceUrl = `https://emweb.securities.eastmoney.com/PC_HKF10/NewFinanceAnalysis/index?code=${secucode}`;
      const bundle: FinancialsBundle = {
        periods,
        currency,
        sourceUrl,
        retrievedAt,
        provider: PROVIDER,
        qualityTier: 'B',
      };

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
        warnings,
      };
    },
  };
}

// ============================================================================
// URL + HK code helpers
// ============================================================================

/** HKEx canonical SECUCODE: 5-digit zero-padded code + '.HK' (e.g. '00700.HK'). */
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

// ============================================================================
// HTTP helpers
// ============================================================================

/**
 * Parse an Eastmoney datacenter response body. Throws ReportConfigNotFoundError
 * on code 9501; returns [] for code 9201 / non-array / success=false-without-
 * 9501 (no-data, not an error).
 */
function parseEmRows(body: string): Array<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error('JSON parse failed');
  }
  const root = parsed as {
    success?: boolean;
    message?: string;
    code?: number;
    result?: { data?: unknown };
  };
  // 9501 = report config not found → hard error (our reportName/columns wrong).
  if (root.code === 9501) {
    throw new ReportConfigNotFoundError(
      `eastmoney HK: report config not found (${root.message ?? 'no message'})`,
    );
  }
  const rows = root.result?.data;
  // 9201 / null result / non-array → no data for this stock (valid). [] sentinel.
  if (!Array.isArray(rows)) return [];
  return rows as Array<Record<string, unknown>>;
}

async function readBody(fetchLike: FetchLike, url: string, signal: AbortSignal): Promise<string> {
  const res = await fetchLike(url, { headers: COMMON_HEADERS, signal });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  return res.text ? await res.text() : JSON.stringify(await res.json());
}

async function fetchMainRows(
  fetchLike: FetchLike,
  url: string,
  signal: AbortSignal,
): Promise<HkMainIndicatorRow[]> {
  const body = await readBody(fetchLike, url, signal);
  return parseEmRows(body) as HkMainIndicatorRow[];
}

/**
 * Fetch the reporting currency from RPT_HKF10_FN_INCOME.CURRENCY_CODE. INCOME
 * is an EAV-style report (many rows per period, one per line item) but every
 * row carries the same CURRENCY_CODE; we just read the first non-empty one.
 * Returns null when unavailable (caller defaults + warns).
 */
async function fetchReportingCurrency(
  fetchLike: FetchLike,
  url: string,
  signal: AbortSignal,
): Promise<string | null> {
  const body = await readBody(fetchLike, url, signal);
  const rows = parseEmRows(body);
  for (const r of rows) {
    const code = r.CURRENCY_CODE;
    if (typeof code === 'string' && /^[A-Z]{3}$/.test(code.trim())) {
      return code.trim();
    }
  }
  return null;
}

// ============================================================================
// Period building (wide row → PeriodEntry)
// ============================================================================

function buildPeriods(
  rows: HkMainIndicatorRow[],
  currency: string,
  years: number,
): FinancialsPeriodEntry[] {
  // Dedup by REPORT_DATE (latest-first input already sorted desc). Cap to
  // `years` worth of annual reports + their interims by tracking distinct FYs.
  const seen = new Set<string>();
  const fys = new Set<number>();
  const out: FinancialsPeriodEntry[] = [];

  for (const r of rows) {
    const reportDate = (r.REPORT_DATE ?? r.STD_REPORT_DATE)?.slice(0, 10);
    if (!reportDate) continue;
    if (seen.has(reportDate)) continue;
    const fy = parseInt(reportDate.slice(0, 4), 10);
    if (!Number.isFinite(fy)) continue;

    // Once we've collected `years` distinct fiscal years, stop adding rows
    // from older years (input is newest-first).
    if (!fys.has(fy) && fys.size >= years) break;

    seen.add(reportDate);
    fys.add(fy);
    out.push(buildEntry(r, reportDate, fy, currency));
  }

  return out;
}

function buildEntry(
  r: HkMainIndicatorRow,
  reportDate: string,
  fy: number,
  currency: string,
): FinancialsPeriodEntry {
  const isAnnual = r.DATE_TYPE_CODE === '001';

  const income = buildIncome(r, currency);
  const balance = buildBalance(r, currency);
  const cashFlow = buildCashFlow(r, currency);

  return {
    fiscalPeriod: isAnnual ? `FY${fy}` : periodLabel(reportDate, fy),
    kind: isAnnual ? 'FY' : 'Q',
    fiscalYearEnd: reportDate,
    // No separate filing date on MAININDICATOR; use period end as the proxy.
    filed: reportDate,
    income,
    balance,
    cashFlow,
  };
}

/** Human label for an interim period from its end-month. */
function periodLabel(reportDate: string, fy: number): string {
  const month = reportDate.slice(5, 7);
  const q = { '03': 'Q1', '06': 'H1', '09': '9M' }[month] ?? 'Q';
  return `${q}-FY${fy}`;
}

function buildIncome(r: HkMainIndicatorRow, currency: string): IncomeStatement {
  const revenue = lineItem(r.OPERATE_INCOME, currency);
  const grossProfit = lineItem(r.GROSS_PROFIT, currency);
  const netIncome = lineItem(r.HOLDER_PROFIT, currency);
  // Diluted first, fallback to basic.
  const eps = lineItem(r.DILUTED_EPS, `${currency}/shares`) ?? lineItem(r.BASIC_EPS, `${currency}/shares`);
  return {
    ...(revenue ? { revenue } : {}),
    ...(grossProfit ? { grossProfit } : {}),
    ...(netIncome ? { netIncome } : {}),
    ...(eps ? { eps } : {}),
  };
}

function buildBalance(r: HkMainIndicatorRow, currency: string): BalanceSheet {
  const totalAssets = lineItem(r.TOTAL_ASSETS, currency);
  const totalLiabilities = lineItem(r.TOTAL_LIABILITIES, currency);
  const equity = lineItem(r.TOTAL_PARENT_EQUITY, currency);
  return {
    ...(totalAssets ? { totalAssets } : {}),
    ...(totalLiabilities ? { totalLiabilities } : {}),
    ...(equity ? { totalStockholdersEquity: equity } : {}),
  };
}

function buildCashFlow(r: HkMainIndicatorRow, currency: string): CashFlow {
  const operating = lineItem(r.NETCASH_OPERATE, currency);
  const investing = lineItem(r.NETCASH_INVEST, currency);
  const financing = lineItem(r.NETCASH_FINANCE, currency);
  return {
    ...(operating ? { operatingCashFlow: operating } : {}),
    ...(investing ? { investingCashFlow: investing } : {}),
    ...(financing ? { financingCashFlow: financing } : {}),
  };
}

/** Coerce a raw field to a LineItem, or undefined when missing / non-finite. */
function lineItem(v: unknown, unit: string): FinancialsLineItem | undefined {
  if (v === null || v === undefined) return undefined;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return undefined;
  return { value: n, unit };
}

// ============================================================================
// Failure helper
// ============================================================================

function failure(
  retrievedAt: string,
  code: ResearchWarning['code'],
  message: string,
  cause?: string,
): ResearchResult<FinancialsBundle | null> {
  return httpFailure<FinancialsBundle | null>(PROVIDER, null, {
    retrievedAt,
    code,
    message,
    ...(cause ? { cause } : {}),
  });
}
