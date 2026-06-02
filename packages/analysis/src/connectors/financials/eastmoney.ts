import { RESEARCH_SCHEMA_VERSION, type ResearchResult } from '../../contracts/result';
import type { ResearchCitation } from '../../contracts/research-citation';
import type { ResearchWarning } from '../../contracts/warning';
import type {
  FinancialsBundle,
  FinancialsInput,
  FinancialsLineItem,
  FinancialsPeriodEntry,
  FinancialsPort,
  BalanceSheet,
  CashFlow,
  IncomeStatement,
} from '../../ports/financials';
import { parseInstrumentId } from '../../util/instrument-id';
import type { ConnectorRunContext, FetchLike } from '../types';
import { failure as httpFailure, resolveFetch, withTimeout } from '../http';
import { deriveTTM } from './ttm-derivation';
import {
  BALANCE_FIELDS,
  BALANCE_FIELDS_EXTRA,
  CASHFLOW_FIELDS,
  CASHFLOW_FIELDS_EXTRA,
  INCOME_FIELDS,
  INCOME_FIELDS_EXTRA,
  type DateTypeCode,
  type EastmoneyFinancialsRow,
  pickNumber,
} from './cn-concept-mapping';

/**
 * RFC financials Phase 2 — Eastmoney datacenter-web CN A-share connector.
 *
 * Endpoint pattern:
 *   https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=X
 *     &columns=ALL&filter=(SECURITY_CODE="600519")&pageSize=20
 *     &sortColumns=REPORT_DATE&sortTypes=-1
 *
 * Three statements, three parallel HTTP calls:
 *   RPT_DMSK_FN_INCOME    — 利润表
 *   RPT_DMSK_FN_BALANCE   — 资产负债表
 *   RPT_DMSK_FN_CASHFLOW  — 现金流量表
 *
 * Period semantics — CN reports are CUMULATIVE within a fiscal year:
 *   DATE_TYPE 003 (Q1)        = Q1 standalone (Jan–Mar)
 *   DATE_TYPE 002 (H1)        = cumulative Jan–Jun
 *   DATE_TYPE 004 (9M)        = cumulative Jan–Sep
 *   DATE_TYPE 001 (FY)        = full year (Jan–Dec)
 *
 * Connector derives standalone Q's so downstream sees the same shape as the
 * SEC EDGAR path:
 *   standalone Q2 = H1 - Q1
 *   standalone Q3 = 9M - H1
 *   standalone Q4 = FY - 9M
 *
 * Failure semantics:
 *   - Non-CN instrumentId → UNSUPPORTED_MARKET envelope (null data)
 *   - Any of 3 endpoints HTTP-fails → SOURCE_UNAVAILABLE (null data)
 *   - All three succeed but no usable periods → PARTIAL_DATA (null data)
 *   - Restatement: REPORT_TYPE_CODE='001' is original, others are restated;
 *     we keep the latest UPDATE_DATE per (REPORT_DATE, DATE_TYPE) pair.
 */

const PROVIDER = 'eastmoney-financials';
const BASE_URL = 'https://datacenter-web.eastmoney.com/api/data/v1/get';
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_YEARS = 5;

const COMMON_HEADERS: Record<string, string> = {
  Referer: 'https://data.eastmoney.com/',
  'User-Agent':
    'Mozilla/5.0 (compatible; Bourse/0.8; +https://bourse.local)',
  Accept: 'application/json, text/plain, */*',
};

export interface EastmoneyFinancialsOptions {
  fetchLike?: FetchLike;
  timeoutMs?: number;
  now?: () => Date;
  /** Page size for datacenter-web requests; ~20 covers 5 years × 4 reports. */
  pageSize?: number;
}

export function createEastmoneyFinancialsConnector(
  options: EastmoneyFinancialsOptions = {},
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
      if (parsed.market !== 'CN') {
        return failure(
          retrievedAt,
          'UNSUPPORTED_MARKET',
          `eastmoney-financials only handles CN A-share; got ${parsed.market}`,
        );
      }

      const fetchLike = resolveFetch(ctx, options);

      const queryFor = (reportName: string) =>
        `${BASE_URL}?reportName=${reportName}` +
        `&columns=ALL` +
        `&filter=(SECURITY_CODE%3D%22${encodeURIComponent(parsed.symbol)}%22)` +
        `&pageNumber=1&pageSize=${pageSize}` +
        `&sortColumns=REPORT_DATE&sortTypes=-1`;

      const incomeUrl = queryFor('RPT_DMSK_FN_INCOME');
      const balanceUrl = queryFor('RPT_DMSK_FN_BALANCE');
      const cashflowUrl = queryFor('RPT_DMSK_FN_CASHFLOW');

      let incomeRows: EastmoneyFinancialsRow[];
      let balanceRows: EastmoneyFinancialsRow[];
      let cashflowRows: EastmoneyFinancialsRow[];
      try {
        // Fan-out: 3 endpoints in parallel under one timeout.
        const [incomeRes, balanceRes, cashflowRes] = await withTimeout(ctx, timeoutMs, (signal) =>
          Promise.all([
            fetchRows(fetchLike, incomeUrl, signal),
            fetchRows(fetchLike, balanceUrl, signal),
            fetchRows(fetchLike, cashflowUrl, signal),
          ]),
        );
        incomeRows = incomeRes;
        balanceRows = balanceRes;
        cashflowRows = cashflowRes;
      } catch (err) {
        const message = (err as Error)?.message ?? String(err);
        return failure(retrievedAt, 'SOURCE_UNAVAILABLE', `Eastmoney fetch error: ${message}`, message);
      }

      if (incomeRows.length === 0 && balanceRows.length === 0 && cashflowRows.length === 0) {
        // No rows = ticker not found or delisted. Distinguish from upstream
        // error (which already threw above) — surface as INVALID_INSTRUMENT.
        return failure(retrievedAt, 'INVALID_INSTRUMENT', `Eastmoney returned no rows for ${parsed.symbol} (delisted? ticker mismatch?)`);
      }

      const years = input.years ?? DEFAULT_YEARS;
      const deriveTTMFlag = input.deriveTTM ?? true;

      // Build PeriodEntry list (FY + standalone Q's).
      const rawPeriods = buildPeriods(incomeRows, balanceRows, cashflowRows, years);

      if (rawPeriods.length === 0) {
        return failure(retrievedAt, 'PARTIAL_DATA', `Eastmoney rows present but no usable periods for ${parsed.symbol}`);
      }

      // TTM derivation reuses the cross-market helper.
      let ttmSkippedReason: string | undefined;
      let finalPeriods = rawPeriods;
      if (deriveTTMFlag) {
        const ttm = deriveTTM(rawPeriods);
        if (ttm.ttmEntry) {
          finalPeriods = [ttm.ttmEntry, ...rawPeriods];
        } else if (ttm.skippedReason) {
          ttmSkippedReason = ttm.skippedReason;
        }
      }

      // Provenance: use the human-readable Eastmoney F10 财务报表 page as the
      // shared sourceUrl + citation URL. The raw datacenter API URLs carry
      // filter params + change shape over time and aren't user-shareable;
      // the F10 page is stable and gets users to the underlying data.
      // Keeping sourceUrl === citation.url is important so downstream
      // EvidencePack consumers can match by URL to recover qualityTier.
      const sourceUrl = `https://emweb.eastmoney.com/PC_HSF10/NewFinanceAnalysis/index?type=web&code=${parsed.symbol}`;
      const bundle: FinancialsBundle = {
        periods: finalPeriods,
        currency: 'CNY',
        sourceUrl,
        retrievedAt,
        provider: PROVIDER,
        qualityTier: 'B',
        ...(ttmSkippedReason ? { ttmSkippedReason } : {}),
      };

      const citation: ResearchCitation = {
        title: `Eastmoney 财务三表: ${parsed.symbol}`,
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

// ============================================================================
// HTTP helper
// ============================================================================

async function fetchRows(
  fetchLike: FetchLike,
  url: string,
  signal: AbortSignal,
): Promise<EastmoneyFinancialsRow[]> {
  const res = await fetchLike(url, { headers: COMMON_HEADERS, signal });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  const body = res.text ? await res.text() : JSON.stringify(await res.json());
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error('JSON parse failed');
  }
  // Some failure responses come 200 + success:false (e.g. unknown reportName)
  const root = parsed as { success?: boolean; message?: string; result?: { data?: unknown } };
  if (root.success === false) {
    throw new Error(root.message ?? 'eastmoney success=false');
  }
  const rows = root.result?.data;
  if (!Array.isArray(rows)) return [];
  return rows as EastmoneyFinancialsRow[];
}

// ============================================================================
// Period building — cumulative → standalone Q
// ============================================================================

interface RawByPeriod {
  income?: EastmoneyFinancialsRow;
  balance?: EastmoneyFinancialsRow;
  cashflow?: EastmoneyFinancialsRow;
  reportDate: string; // 'YYYY-MM-DD'
  dateType: DateTypeCode;
  fy: number;
}

/**
 * Group rows from 3 endpoints by REPORT_DATE, then derive standalone Q's from
 * cumulative period reports. Output: latest-first PeriodEntry list capped at
 * `years` fiscal years.
 *
 * Filtering rules:
 *   - For each (REPORT_DATE, DATE_TYPE_CODE), keep only the latest revision
 *     (heuristic: max NOTICE_DATE; falls back to first occurrence).
 *   - Skip rows with unparseable REPORT_DATE.
 */
function buildPeriods(
  income: EastmoneyFinancialsRow[],
  balance: EastmoneyFinancialsRow[],
  cashflow: EastmoneyFinancialsRow[],
  years: number,
): FinancialsPeriodEntry[] {
  const grouped = new Map<string, RawByPeriod>();

  const visit = (
    rows: EastmoneyFinancialsRow[],
    pick: (g: RawByPeriod, r: EastmoneyFinancialsRow) => void,
  ) => {
    for (const r of rows) {
      const dt = r.DATE_TYPE_CODE as DateTypeCode;
      if (!dt || !['001', '002', '003', '004'].includes(dt)) continue;
      const rd = r.REPORT_DATE?.slice(0, 10);
      if (!rd) continue;
      const fy = parseInt(rd.slice(0, 4), 10);
      if (!Number.isFinite(fy)) continue;
      const key = `${rd}|${dt}`;
      let g = grouped.get(key);
      if (!g) {
        g = { reportDate: rd, dateType: dt, fy };
        grouped.set(key, g);
      }
      pick(g, r);
    }
  };

  visit(income, (g, r) => {
    // Prefer the newer NOTICE_DATE (restatement-aware).
    if (!g.income || (r.NOTICE_DATE ?? '') > (g.income.NOTICE_DATE ?? '')) g.income = r;
  });
  visit(balance, (g, r) => {
    if (!g.balance || (r.NOTICE_DATE ?? '') > (g.balance.NOTICE_DATE ?? '')) g.balance = r;
  });
  visit(cashflow, (g, r) => {
    if (!g.cashflow || (r.NOTICE_DATE ?? '') > (g.cashflow.NOTICE_DATE ?? '')) g.cashflow = r;
  });

  // Bucket per fiscal year, period-end ordered.
  // For each FY, derive [Q1, Q2 (=H1-Q1), Q3 (=9M-H1), Q4 (=FY-9M), FY].
  const byFy = new Map<number, Map<DateTypeCode, RawByPeriod>>();
  for (const g of grouped.values()) {
    let fyMap = byFy.get(g.fy);
    if (!fyMap) {
      fyMap = new Map();
      byFy.set(g.fy, fyMap);
    }
    fyMap.set(g.dateType, g);
  }

  // Output FY (newest-first) up to `years`; Q's interleaved.
  const fys = [...byFy.keys()].sort((a, b) => b - a).slice(0, years);

  const out: FinancialsPeriodEntry[] = [];
  for (const fy of fys) {
    const fyMap = byFy.get(fy)!;
    const q1Cum = fyMap.get('003'); // Q1 standalone
    const h1Cum = fyMap.get('002'); // H1 cumulative
    const nineMCum = fyMap.get('004'); // 9M cumulative
    const fyCum = fyMap.get('001'); // FY

    // Standalone derivation; each is undefined if its dependencies are missing.
    const q1 = q1Cum ? makeStandalonePeriod(fy, 'Q1', q1Cum, null) : null;
    const q2 = h1Cum && q1Cum ? makeStandalonePeriod(fy, 'Q2', h1Cum, q1Cum) : null;
    const q3 = nineMCum && h1Cum ? makeStandalonePeriod(fy, 'Q3', nineMCum, h1Cum) : null;
    const q4 = fyCum && nineMCum ? makeStandalonePeriod(fy, 'Q4', fyCum, nineMCum) : null;
    const fyEntry = fyCum ? makeStandalonePeriod(fy, 'FY', fyCum, null) : null;

    // Order: FY first, then Q4, Q3, Q2, Q1 within that FY (newest-first).
    if (fyEntry) out.push(fyEntry);
    if (q4) out.push(q4);
    if (q3) out.push(q3);
    if (q2) out.push(q2);
    if (q1) out.push(q1);
  }

  // Sort everything newest-first by (fiscalYearEnd desc, kind FY > Q).
  out.sort((a, b) => {
    if (a.fiscalYearEnd !== b.fiscalYearEnd) {
      return a.fiscalYearEnd < b.fiscalYearEnd ? 1 : -1;
    }
    // Same end-date → FY wins over Q. (Should only happen for Q4 vs FY same end.)
    if (a.kind === 'FY' && b.kind === 'Q') return -1;
    if (a.kind === 'Q' && b.kind === 'FY') return 1;
    return 0;
  });

  return out;
}

/**
 * Build a single PeriodEntry. When `subtract` is provided, line items are
 * `cumulative - subtract` (used to derive standalone Q from two cumulative
 * reports). When `subtract` is null, the cumulative row IS the standalone
 * period (Q1, FY).
 */
function makeStandalonePeriod(
  fy: number,
  kind: 'Q1' | 'Q2' | 'Q3' | 'Q4' | 'FY',
  cumulativeRow: RawByPeriod,
  subtract: RawByPeriod | null,
): FinancialsPeriodEntry {
  const income = buildIncome(cumulativeRow, subtract);
  const balance = buildBalance(cumulativeRow);
  const cashFlow = buildCashFlow(cumulativeRow, subtract);

  // freeCashFlow derivation
  if (cashFlow.operatingCashFlow && cashFlow.capitalExpenditures) {
    cashFlow.freeCashFlow = {
      value: cashFlow.operatingCashFlow.value - cashFlow.capitalExpenditures.value,
      unit: cashFlow.operatingCashFlow.unit,
    };
  }

  const filed =
    cumulativeRow.income?.NOTICE_DATE?.slice(0, 10) ??
    cumulativeRow.balance?.NOTICE_DATE?.slice(0, 10) ??
    cumulativeRow.cashflow?.NOTICE_DATE?.slice(0, 10) ??
    cumulativeRow.reportDate;

  const fiscalPeriod = kind === 'FY' ? `FY${fy}` : `${kind}-FY${fy}`;

  return {
    fiscalPeriod,
    kind: kind === 'FY' ? 'FY' : 'Q',
    fiscalYearEnd: cumulativeRow.reportDate,
    filed,
    // CN form types don't map to US enum (10-K / 10-Q). Leave undefined;
    // schema treats it as optional.
    income,
    balance,
    cashFlow,
  };
}

function buildIncome(
  cum: RawByPeriod,
  sub: RawByPeriod | null,
): IncomeStatement {
  const revenue = subtractField(cum, sub, 'income', INCOME_FIELDS.revenue);
  const costOfRevenue = subtractField(cum, sub, 'income', INCOME_FIELDS.costOfRevenue);
  // grossProfit derived
  let grossProfit: FinancialsLineItem | undefined;
  if (revenue && costOfRevenue) {
    grossProfit = { value: revenue.value - costOfRevenue.value, unit: revenue.unit };
  }

  // plan-v2 §5.1 — interestExpense uses 财务费用 (financeExpense) as proxy.
  // CN GAAP rolls interest + FX + bank charges into a single line; for non-
  // financials this is ~85% interest. For banks/insurers it's meaningless,
  // but those firms also typically have negative operating-vs-interest
  // ratios so the red-flag self-skips on operatingIncome ≤ 0.
  const interestExpense = subtractField(cum, sub, 'income', INCOME_FIELDS_EXTRA.financeExpense);
  // sellingGeneralAdministrative = 销售费用 + 管理费用 (CN GAAP keeps these
  // split; US filers usually combine into one SG&A line).
  const sellExpense = subtractField(cum, sub, 'income', INCOME_FIELDS_EXTRA.sellExpense);
  const manageExpense = subtractField(cum, sub, 'income', INCOME_FIELDS_EXTRA.manageExpense);
  const sga = sumLineItems(sellExpense, manageExpense);

  return {
    ...(revenue ? { revenue } : {}),
    ...(costOfRevenue ? { costOfRevenue } : {}),
    ...(grossProfit ? { grossProfit } : {}),
    ...(maybeField(cum, sub, 'income', INCOME_FIELDS.operatingIncome, 'operatingIncome')),
    ...(maybeField(cum, sub, 'income', INCOME_FIELDS.netIncome, 'netIncome')),
    // EPS not exposed on income-statement endpoint; left undefined (FY EPS
    // can come from RPT_LICO_FN_CPD but not in Phase 2 scope).
    ...(interestExpense ? { interestExpense } : {}),
    ...(maybeField(cum, sub, 'income', INCOME_FIELDS_EXTRA.incomeTax, 'incomeTaxExpense')),
    ...(maybeField(
      cum,
      sub,
      'income',
      INCOME_FIELDS_EXTRA.researchExpense,
      'researchAndDevelopment',
    )),
    ...(sga ? { sellingGeneralAdministrative: sga } : {}),
  };
}

function buildBalance(cum: RawByPeriod): BalanceSheet {
  // Balance sheet is a point-in-time, never subtracted.
  return {
    ...(maybeField(cum, null, 'balance', BALANCE_FIELDS.totalAssets, 'totalAssets')),
    ...(maybeField(cum, null, 'balance', BALANCE_FIELDS.totalLiabilities, 'totalLiabilities')),
    ...(maybeField(cum, null, 'balance', BALANCE_FIELDS.totalStockholdersEquity, 'totalStockholdersEquity')),
    ...(maybeField(cum, null, 'balance', BALANCE_FIELDS.cashAndCashEquivalents, 'cashAndCashEquivalents')),
    ...(maybeField(cum, null, 'balance', BALANCE_FIELDS.longTermDebt, 'longTermDebt')),
    ...(maybeField(cum, null, 'balance', BALANCE_FIELDS_EXTRA.accountsReceivable, 'accountsReceivable')),
    ...(maybeField(cum, null, 'balance', BALANCE_FIELDS_EXTRA.inventory, 'inventory')),
    ...(maybeField(cum, null, 'balance', BALANCE_FIELDS_EXTRA.goodwill, 'goodwill')),
    ...(maybeField(cum, null, 'balance', BALANCE_FIELDS_EXTRA.intangibleAsset, 'intangibleAssets')),
    ...(maybeField(cum, null, 'balance', BALANCE_FIELDS_EXTRA.totalCurrentAssets, 'currentAssets')),
    ...(maybeField(
      cum,
      null,
      'balance',
      BALANCE_FIELDS_EXTRA.totalCurrentLiabilities,
      'currentLiabilities',
    )),
    ...(maybeField(cum, null, 'balance', BALANCE_FIELDS_EXTRA.shortLoan, 'shortTermDebt')),
    ...(maybeField(cum, null, 'balance', BALANCE_FIELDS_EXTRA.accountsPayable, 'accountsPayable')),
  };
}

function buildCashFlow(
  cum: RawByPeriod,
  sub: RawByPeriod | null,
): CashFlow {
  // D&A = 固定资产折旧 + 无形资产摊销 + 长期待摊费用摊销. CN GAAP splits
  // these across three line items; sum them so downstream parity with US
  // XBRL's DepreciationDepletionAndAmortization holds.
  const dep = subtractField(cum, sub, 'cashflow', CASHFLOW_FIELDS_EXTRA.faDepreciation);
  const iaAmort = subtractField(cum, sub, 'cashflow', CASHFLOW_FIELDS_EXTRA.iaAmortization);
  const lpeAmort = subtractField(cum, sub, 'cashflow', CASHFLOW_FIELDS_EXTRA.lpeAmortization);
  const da = sumLineItems(dep, iaAmort, lpeAmort);

  return {
    ...(maybeField(cum, sub, 'cashflow', CASHFLOW_FIELDS.operatingCashFlow, 'operatingCashFlow')),
    ...(maybeField(cum, sub, 'cashflow', CASHFLOW_FIELDS.investingCashFlow, 'investingCashFlow')),
    ...(maybeField(cum, sub, 'cashflow', CASHFLOW_FIELDS.financingCashFlow, 'financingCashFlow')),
    ...(maybeField(cum, sub, 'cashflow', CASHFLOW_FIELDS.capitalExpenditures, 'capitalExpenditures')),
    ...(da ? { depreciationAndAmortization: da } : {}),
    ...(maybeField(
      cum,
      sub,
      'cashflow',
      CASHFLOW_FIELDS_EXTRA.paymentDividend,
      'paymentsOfDividends',
    )),
  };
}

/**
 * Sum 2-3 LineItems sharing a currency. Returns undefined if all inputs
 * are undefined; partial sums proceed (CN companies that don't book LPE
 * amortization still get D&A from depreciation + IA amortization alone).
 */
function sumLineItems(
  ...items: Array<FinancialsLineItem | undefined>
): FinancialsLineItem | undefined {
  let total = 0;
  let unit: string | undefined;
  let any = false;
  for (const it of items) {
    if (!it) continue;
    total += it.value;
    unit = it.unit;
    any = true;
  }
  if (!any || !unit) return undefined;
  return { value: total, unit };
}

/**
 * Wrapper that maps `field` from `cum.<endpoint>` (optionally minus
 * `sub.<endpoint>` for standalone Q derivation) into a `{ key: LineItem }`
 * partial object, suitable for spreading into a statement literal.
 */
function maybeField<K extends string>(
  cum: RawByPeriod,
  sub: RawByPeriod | null,
  endpoint: 'income' | 'balance' | 'cashflow',
  field: string,
  outKey: K,
): { [P in K]?: FinancialsLineItem } {
  const v = subtractField(cum, sub, endpoint, field);
  return v ? ({ [outKey]: v } as { [P in K]?: FinancialsLineItem }) : ({} as { [P in K]?: FinancialsLineItem });
}

function subtractField(
  cum: RawByPeriod,
  sub: RawByPeriod | null,
  endpoint: 'income' | 'balance' | 'cashflow',
  field: string,
): FinancialsLineItem | undefined {
  const cumRow = cum[endpoint];
  if (!cumRow) return undefined;
  const cumVal = pickNumber(cumRow, field);
  if (cumVal === null) return undefined;
  if (!sub) return { value: cumVal, unit: 'CNY' };
  const subRow = sub[endpoint];
  if (!subRow) return undefined;
  const subVal = pickNumber(subRow, field);
  if (subVal === null) return undefined;
  return { value: cumVal - subVal, unit: 'CNY' };
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
