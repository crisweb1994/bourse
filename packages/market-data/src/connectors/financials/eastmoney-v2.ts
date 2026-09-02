import { RESEARCH_SCHEMA_VERSION, type ResearchResult } from '../../contracts/result';
import type { ResearchCitation } from '../../contracts/research-citation';
import type { ResearchWarning } from '../../contracts/warning';
import { DecimalStringSchema } from '../../contracts/scalars';
import { FinancialsBundleV2Schema, type FinancialFact, type FinancialsBundleV2, type ProviderFinancialsV2Port } from '../../ports/financials-v2';
import { parseInstrumentId } from '../../util/instrument-id';
import { decimalSubtract } from '../../util/exact-decimal';
import type { ConnectorRunContext, FetchLike } from '../types';
import { failure as httpFailure, resolveFetch, withTimeout, HttpError, failureCodeFor } from '../http';
import {
  type DateTypeCode,
  type EastmoneyFinancialsRow,
  pickNumber,
} from './cn-concept-mapping';

/**
 * Eastmoney datacenter-web CN A-share connector — v2（structured-first earnings）。
 *
 * 状态：**仅本地研究 / shadow eval，未过东财 ToS 合规自检前不接生产**
 * （docs/structured-first-earnings-architecture.md §5、§20）。
 *
 * 与 v1（eastmoney.ts）的差异：
 * - 同时保留 reported 累计期（Q1/H1/9M/FY，accumulation YTD/FY）与
 *   computed 派生单季（Q2=H1−Q1、Q3=9M−H1、Q4=FY−9M，显式公式 + 输入 fact ID）；
 * - `PARENT_NETPROFIT → netIncomeAttrib`，`NETPROFIT → netIncome`，不再降级；
 * - EPS：从利润表行读 `BASIC_EPS/DILUTED_EPS`（部分股票该列 9501 缺失则缺失，
 *   不做累计相减，不填 0）；
 * - 重述/更正：同一 (REPORT_DATE, DATE_TYPE_CODE) 优先保留 UPDATE_DATE 较新版本，
 *   无 UPDATE_DATE 用 NOTICE_DATE（v1 只用 NOTICE_DATE，且注释与实现不一致）；
 * - 派生值全部走精确十进制减法（exact-decimal），不产生浮点误差；
 * - 资产负债表 instant 值不做差分；periodEndOn 不再冒充 NOTICE_DATE。
 */

const PROVIDER = 'eastmoney-financials-v2';
const BASE_URL = 'https://datacenter.eastmoney.com/securities/api/data/v1/get';
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_YEARS = 5;

const COMMON_HEADERS: Record<string, string> = {
  Referer: 'https://data.eastmoney.com/',
  'User-Agent': 'Mozilla/5.0 (compatible; Bourse/0.8; +https://bourse.local)',
  Accept: 'application/json, text/plain, */*',
};

export interface EastmoneyV2Options {
  fetchLike?: FetchLike;
  timeoutMs?: number;
  now?: () => Date;
  pageSize?: number;
}

export function createEastmoneyV2FinancialsConnector(
  options: EastmoneyV2Options = {},
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
      if (parsed.market !== 'CN') {
        return failure(
          retrievedAt,
          'UNSUPPORTED_MARKET',
          `eastmoney-financials-v2 only handles CN A-share; got ${parsed.market}`,
        );
      }
      const providerSymbol =
        ctx.resolvedInstrument?.instrumentId === parsed.raw
          ? ctx.resolvedInstrument.providerSymbol
          : parsed.symbol;
      const fetchLike = resolveFetch(ctx, options);

      const queryFor = (reportName: string) =>
        `${BASE_URL}?reportName=${reportName}` +
        `&columns=ALL` +
        `&filter=(SECURITY_CODE%3D%22${encodeURIComponent(providerSymbol)}%22)` +
        `&pageNumber=1&pageSize=${pageSize}` +
        `&sortColumns=REPORT_DATE&sortTypes=-1`;

      let incomeRows: EastmoneyFinancialsRow[];
      let balanceRows: EastmoneyFinancialsRow[];
      let cashflowRows: EastmoneyFinancialsRow[];
      try {
        const [income, balance, cashflow] = await withTimeout(ctx, ctx.timeoutMs ?? timeoutMs, (signal) =>
          Promise.all([
            fetchRows(fetchLike, queryFor('RPT_DMSK_FN_INCOME'), signal),
            fetchRows(fetchLike, queryFor('RPT_DMSK_FN_BALANCE'), signal),
            fetchRows(fetchLike, queryFor('RPT_DMSK_FN_CASHFLOW'), signal),
          ]),
        );
        incomeRows = income;
        balanceRows = balance;
        cashflowRows = cashflow;
      } catch (err) {
        const message = (err as Error)?.message ?? String(err);
        return failure(retrievedAt, failureCodeFor(err), `Eastmoney fetch error: ${message}`, message);
      }

      if (incomeRows.length === 0 && balanceRows.length === 0 && cashflowRows.length === 0) {
        return failure(retrievedAt, 'INVALID_INSTRUMENT', `Eastmoney returned no rows for ${parsed.symbol} (delisted? ticker mismatch?)`);
      }

      const years = input.years ?? DEFAULT_YEARS;
      const snapshotId = `snap-${retrievedAt}-${parsed.symbol}`;
      const sourceUrl = `https://emweb.eastmoney.com/PC_HSF10/NewFinanceAnalysis/index?type=web&code=${parsed.symbol}`;
      const periods = buildPeriods(
        incomeRows,
        balanceRows,
        cashflowRows,
        years,
        snapshotId,
        sourceUrl,
        retrievedAt,
      );
      if (periods.length === 0) {
        return failure(retrievedAt, 'PARTIAL_DATA', `Eastmoney rows present but no usable periods for ${parsed.symbol}`);
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

async function fetchRows(
  fetchLike: FetchLike,
  url: string,
  signal: AbortSignal,
): Promise<EastmoneyFinancialsRow[]> {
  const res = await fetchLike(url, { headers: COMMON_HEADERS, signal });
  if (!res.ok) throw new HttpError(`HTTP ${res.status}`, res.status);
  const body = res.text ? await res.text() : JSON.stringify(await res.json());
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error('JSON parse failed');
  }
  const root = parsed as { success?: boolean; message?: string; result?: { data?: unknown } };
  if (root.success === false) throw new Error(root.message ?? 'eastmoney success=false');
  const rows = root.result?.data;
  if (!Array.isArray(rows)) return [];
  return rows as EastmoneyFinancialsRow[];
}

// ============================================================================
// Period building
// ============================================================================

interface RawByPeriod {
  reportDate: string;
  dateType: DateTypeCode;
  fy: number;
  noticeDate?: string;
  updateDate?: string;
  reportTypeCode?: string;
  income?: EastmoneyFinancialsRow;
  balance?: EastmoneyFinancialsRow;
  cashflow?: EastmoneyFinancialsRow;
}

function buildPeriods(
  income: EastmoneyFinancialsRow[],
  balance: EastmoneyFinancialsRow[],
  cashflow: EastmoneyFinancialsRow[],
  years: number,
  snapshotId: string,
  sourceUrl: string,
  retrievedAt: string,
) {
  const grouped = groupRows(income, balance, cashflow);
  const byFy = new Map<number, Map<DateTypeCode, RawByPeriod>>();
  for (const group of grouped.values()) {
    let fyMap = byFy.get(group.fy);
    if (!fyMap) {
      fyMap = new Map();
      byFy.set(group.fy, fyMap);
    }
    fyMap.set(group.dateType, group);
  }

  const fys = [...byFy.keys()].sort((a, b) => b - a).slice(0, years);
  const periods = [];
  for (const fy of fys) {
    const fyMap = byFy.get(fy)!;
    const q1 = fyMap.get('003');
    const h1 = fyMap.get('002');
    const nineM = fyMap.get('004');
    const fyRow = fyMap.get('001');

    if (q1) periods.push(buildReportedPeriod(fy, 'Q1', q1, snapshotId, sourceUrl, retrievedAt));
    if (h1) periods.push(buildReportedPeriod(fy, 'H1', h1, snapshotId, sourceUrl, retrievedAt));
    if (nineM) periods.push(buildReportedPeriod(fy, '9M', nineM, snapshotId, sourceUrl, retrievedAt));
    if (fyRow) periods.push(buildReportedPeriod(fy, 'FY', fyRow, snapshotId, sourceUrl, retrievedAt));
    if (h1 && q1) periods.push(buildDerivedPeriod(fy, 'Q2', h1, q1, snapshotId, sourceUrl, retrievedAt));
    if (nineM && h1) periods.push(buildDerivedPeriod(fy, 'Q3', nineM, h1, snapshotId, sourceUrl, retrievedAt));
    if (fyRow && nineM) periods.push(buildDerivedPeriod(fy, 'Q4', fyRow, nineM, snapshotId, sourceUrl, retrievedAt));
  }
  return periods;
}

function groupRows(
  income: EastmoneyFinancialsRow[],
  balance: EastmoneyFinancialsRow[],
  cashflow: EastmoneyFinancialsRow[],
): Map<string, RawByPeriod> {
  const grouped = new Map<string, RawByPeriod>();
  const visit = (
    rows: EastmoneyFinancialsRow[],
    pick: (g: RawByPeriod, r: EastmoneyFinancialsRow) => void,
  ) => {
    for (const row of rows) {
      const dt = row.DATE_TYPE_CODE;
      if (!dt || !['001', '002', '003', '004'].includes(dt)) continue;
      const rd = row.REPORT_DATE?.slice(0, 10);
      if (!rd || !/^\d{4}-\d{2}-\d{2}$/.test(rd)) continue;
      const fy = Number(rd.slice(0, 4));
      if (!Number.isFinite(fy)) continue;
      const key = `${rd}|${dt}`;
      let g = grouped.get(key);
      if (!g) {
        g = {
          reportDate: rd,
          dateType: dt as DateTypeCode,
          fy,
          noticeDate: row.NOTICE_DATE?.slice(0, 10),
          updateDate: row.UPDATE_DATE?.slice(0, 10),
          reportTypeCode: row.REPORT_TYPE_CODE,
        };
        grouped.set(key, g);
      }
      pick(g, row);
    }
  };

  visit(income, (g, r) => {
    if (!g.income || newerVersion(r, g.income)) {
      g.income = r;
      adoptVersion(g, r);
    }
  });
  visit(balance, (g, r) => {
    if (!g.balance || newerVersion(r, g.balance)) {
      g.balance = r;
      adoptVersion(g, r);
    }
  });
  visit(cashflow, (g, r) => {
    if (!g.cashflow || newerVersion(r, g.cashflow)) {
      g.cashflow = r;
      adoptVersion(g, r);
    }
  });
  return grouped;
}

/** 重述/更正版本比较：优先 UPDATE_DATE，其次 NOTICE_DATE（ISO 字符串比较）。 */
function newerVersion(a: EastmoneyFinancialsRow, b: EastmoneyFinancialsRow): boolean {
  const versionOf = (row: EastmoneyFinancialsRow) =>
    row.UPDATE_DATE?.slice(0, 10) ?? row.NOTICE_DATE?.slice(0, 10) ?? '';
  return versionOf(a) > versionOf(b);
}

function adoptVersion(group: RawByPeriod, row: EastmoneyFinancialsRow): void {
  group.updateDate = row.UPDATE_DATE?.slice(0, 10) ?? group.updateDate;
  group.noticeDate = row.NOTICE_DATE?.slice(0, 10) ?? group.noticeDate;
  group.reportTypeCode = row.REPORT_TYPE_CODE ?? group.reportTypeCode;
}

function buildReportedPeriod(
  fy: number,
  periodType: 'Q1' | 'H1' | '9M' | 'FY',
  raw: RawByPeriod,
  snapshotId: string,
  sourceUrl: string,
  retrievedAt: string,
) {
  const periodId = `period-${fy}-${periodType}`;
  const periodStartOn = `${fy}-01-01`;
  const facts: FinancialFact[] = [];

  const pushReported = (
    metricCode: FinancialFact['metricCode'],
    value: number | null,
    field: string,
    unit: FinancialFact['unit'] = 'currency',
  ) => {
    if (value === null) return;
    const decimal = String(value);
    if (!DecimalStringSchema.safeParse(decimal).success) return;
    facts.push({
      id: `${periodId}:${metricCode}`,
      metricCode,
      value: decimal,
      unit,
      currency: 'CNY',
      scale: 1,
      periodKind: 'duration',
      periodStartOn,
      periodEndOn: raw.reportDate,
      accumulation: periodType === 'FY' ? 'FY' : 'YTD',
      accountingBasis: 'CAS',
      reportingScope: 'consolidated',
      derivation: { kind: 'reported' },
      provenance: {
        provider: PROVIDER,
        sourceNature: 'aggregated_structured',
        qualityTier: 'B',
        sourceUrl,
        sourceField: field,
        ...(raw.noticeDate ? { sourceFiledAt: toDateTime(raw.noticeDate) } : {}),
        ...(raw.reportTypeCode ? { sourceRevisionId: `${raw.reportTypeCode}:${raw.updateDate ?? raw.noticeDate ?? ''}` } : {}),
        snapshotId,
        retrievedAt,
      },
    });
  };

  const pushBalance = (
    metricCode: FinancialFact['metricCode'],
    value: number | null,
    field: string,
  ) => {
    if (value === null) return;
    const decimal = String(value);
    if (!DecimalStringSchema.safeParse(decimal).success) return;
    facts.push({
      id: `${periodId}:${metricCode}`,
      metricCode,
      value: decimal,
      unit: 'currency',
      currency: 'CNY',
      scale: 1,
      periodKind: 'instant',
      periodEndOn: raw.reportDate,
      accountingBasis: 'CAS',
      reportingScope: 'consolidated',
      derivation: { kind: 'reported' },
      provenance: {
        provider: PROVIDER,
        sourceNature: 'aggregated_structured',
        qualityTier: 'B',
        sourceUrl,
        sourceField: field,
        ...(raw.noticeDate ? { sourceFiledAt: toDateTime(raw.noticeDate) } : {}),
        snapshotId,
        retrievedAt,
      },
    });
  };

  const incomeRow = raw.income;
  pushReported('revenue', incomeRow ? pickNumber(incomeRow, 'TOTAL_OPERATE_INCOME') : null, 'TOTAL_OPERATE_INCOME');
  const revenue = facts.find((fact) => fact.metricCode === 'revenue');
  pushReported('costOfRevenue', incomeRow ? pickNumber(incomeRow, 'OPERATE_COST') : null, 'OPERATE_COST');
  const cost = facts.find((fact) => fact.metricCode === 'costOfRevenue');
  pushReported('operatingIncome', incomeRow ? pickNumber(incomeRow, 'OPERATE_PROFIT') : null, 'OPERATE_PROFIT');
  pushReported('netIncome', incomeRow ? pickNumber(incomeRow, 'NETPROFIT') : null, 'NETPROFIT');
  pushReported('netIncomeAttrib', incomeRow ? pickNumber(incomeRow, 'PARENT_NETPROFIT') : null, 'PARENT_NETPROFIT');
  pushReported('epsBasic', incomeRow ? pickNumber(incomeRow, 'BASIC_EPS') : null, 'BASIC_EPS', 'per_share');
  pushReported('epsDiluted', incomeRow ? pickNumber(incomeRow, 'DILUTED_EPS') : null, 'DILUTED_EPS', 'per_share');
  if (revenue && cost) pushComputed(facts, 'grossProfit', revenue, cost, 'revenue-minus-costOfRevenue-v1', 'grossProfit');

  const cashflowRow = raw.cashflow;
  pushReported('operatingCashFlow', cashflowRow ? pickNumber(cashflowRow, 'NETCASH_OPERATE') : null, 'NETCASH_OPERATE');
  const ocf = facts.find((fact) => fact.metricCode === 'operatingCashFlow');
  pushReported('capitalExpenditures', cashflowRow ? pickNumber(cashflowRow, 'CONSTRUCT_LONG_ASSET') : null, 'CONSTRUCT_LONG_ASSET');
  const capex = facts.find((fact) => fact.metricCode === 'capitalExpenditures');
  if (ocf && capex) pushComputed(facts, 'freeCashFlow', ocf, capex, 'ocf-minus-capex-v1', 'freeCashFlow');

  const balanceRow = raw.balance;
  pushBalance('totalAssets', balanceRow ? pickNumber(balanceRow, 'TOTAL_ASSETS') : null, 'TOTAL_ASSETS');
  pushBalance('totalLiabilities', balanceRow ? pickNumber(balanceRow, 'TOTAL_LIABILITIES') : null, 'TOTAL_LIABILITIES');
  pushBalance('totalEquity', balanceRow ? pickNumber(balanceRow, 'TOTAL_EQUITY') : null, 'TOTAL_EQUITY');
  pushBalance('cashAndCashEquivalents', balanceRow ? pickNumber(balanceRow, 'MONETARYFUNDS') : null, 'MONETARYFUNDS');

  return {
    id: periodId,
    fiscalYear: fy,
    fiscalPeriodType: periodType,
    periodStartOn,
    periodEndOn: raw.reportDate,
    ...(raw.noticeDate ? { publishedAt: toDateTime(raw.noticeDate) } : {}),
    reportingScope: 'consolidated',
    accountingBasis: 'CAS',
    revision: { kind: raw.reportTypeCode && raw.reportTypeCode !== '001' ? 'restated' : 'original' },
    facts,
  };
}

function buildDerivedPeriod(
  fy: number,
  periodType: 'Q2' | 'Q3' | 'Q4',
  cum: RawByPeriod,
  sub: RawByPeriod,
  snapshotId: string,
  sourceUrl: string,
  retrievedAt: string,
) {
  const periodId = `period-${fy}-${periodType}`;
  const periodStartOn =
    periodType === 'Q2' ? `${fy}-04-01` : periodType === 'Q3' ? `${fy}-07-01` : `${fy}-10-01`;
  const facts: FinancialFact[] = [];

  const pushDerived = (
    metricCode: FinancialFact['metricCode'],
    cumValue: number | null,
    subValue: number | null,
    cumField: string,
    subField: string,
  ) => {
    if (cumValue === null || subValue === null) return;
    const a = String(cumValue);
    const b = String(subValue);
    if (!DecimalStringSchema.safeParse(a).success || !DecimalStringSchema.safeParse(b).success) return;
    const value = decimalSubtract(a, b);
    const cumType: Record<DateTypeCode, string> = { '001': 'FY', '002': 'H1', '003': 'Q1', '004': '9M' };
    const subType: Record<DateTypeCode, string> = { '001': 'FY', '002': 'H1', '003': 'Q1', '004': '9M' };
    const inputA = `period-${fy}-${cumType[cum.dateType]}:${metricCode}`;
    const inputB = `period-${fy}-${subType[sub.dateType]}:${metricCode}`;
    facts.push({
      id: `${periodId}:${metricCode}`,
      metricCode,
      value,
      unit: 'currency',
      currency: 'CNY',
      scale: 1,
      periodKind: 'duration',
      periodStartOn,
      periodEndOn: cum.reportDate,
      accumulation: 'discrete',
      accountingBasis: 'CAS',
      reportingScope: 'consolidated',
      derivation: {
        kind: 'computed',
        formula: 'cn-discrete-quarter-v1',
        inputFactIds: [inputA, inputB],
      },
      provenance: {
        provider: PROVIDER,
        sourceNature: 'aggregated_structured',
        qualityTier: 'B',
        sourceUrl,
        sourceField: `derived:${periodType}=${cumField}-${subField}`,
        ...(cum.noticeDate ? { sourceFiledAt: toDateTime(cum.noticeDate) } : {}),
        snapshotId,
        retrievedAt,
      },
    });
  };

  const incomeCum = cum.income;
  const incomeSub = sub.income;
  const pushIncomeDerived = (metricCode: FinancialFact['metricCode'], cumField: string, subField: string) => {
    pushDerived(
      metricCode,
      incomeCum ? pickNumber(incomeCum, cumField) : null,
      incomeSub ? pickNumber(incomeSub, subField) : null,
      cumField,
      subField,
    );
  };
  pushIncomeDerived('revenue', 'TOTAL_OPERATE_INCOME', 'TOTAL_OPERATE_INCOME');
  pushIncomeDerived('costOfRevenue', 'OPERATE_COST', 'OPERATE_COST');
  pushIncomeDerived('operatingIncome', 'OPERATE_PROFIT', 'OPERATE_PROFIT');
  pushIncomeDerived('netIncome', 'NETPROFIT', 'NETPROFIT');
  pushIncomeDerived('netIncomeAttrib', 'PARENT_NETPROFIT', 'PARENT_NETPROFIT');
  const revenue = facts.find((fact) => fact.metricCode === 'revenue');
  const cost = facts.find((fact) => fact.metricCode === 'costOfRevenue');
  if (revenue && cost) pushComputed(facts, 'grossProfit', revenue, cost, 'revenue-minus-costOfRevenue-v1', 'grossProfit');

  const cashflowCum = cum.cashflow;
  const cashflowSub = sub.cashflow;
  const pushCashDerived = (metricCode: FinancialFact['metricCode'], cumField: string, subField: string) => {
    pushDerived(
      metricCode,
      cashflowCum ? pickNumber(cashflowCum, cumField) : null,
      cashflowSub ? pickNumber(cashflowSub, subField) : null,
      cumField,
      subField,
    );
  };
  pushCashDerived('operatingCashFlow', 'NETCASH_OPERATE', 'NETCASH_OPERATE');
  pushCashDerived('capitalExpenditures', 'CONSTRUCT_LONG_ASSET', 'CONSTRUCT_LONG_ASSET');
  const ocf = facts.find((fact) => fact.metricCode === 'operatingCashFlow');
  const capex = facts.find((fact) => fact.metricCode === 'capitalExpenditures');
  if (ocf && capex) pushComputed(facts, 'freeCashFlow', ocf, capex, 'ocf-minus-capex-v1', 'freeCashFlow');

  // 资产负债表是时点值：派生期间直接取累计期末行（不做差分）。
  const balanceRow = cum.balance;
  const pushBalance = (metricCode: FinancialFact['metricCode'], field: string) => {
    const value = balanceRow ? pickNumber(balanceRow, field) : null;
    if (value === null) return;
    const decimal = String(value);
    if (!DecimalStringSchema.safeParse(decimal).success) return;
    facts.push({
      id: `${periodId}:${metricCode}`,
      metricCode,
      value: decimal,
      unit: 'currency',
      currency: 'CNY',
      scale: 1,
      periodKind: 'instant',
      periodEndOn: cum.reportDate,
      accountingBasis: 'CAS',
      reportingScope: 'consolidated',
      derivation: { kind: 'reported' },
      provenance: {
        provider: PROVIDER,
        sourceNature: 'aggregated_structured',
        qualityTier: 'B',
        sourceUrl,
        sourceField: field,
        snapshotId,
        retrievedAt,
      },
    });
  };
  pushBalance('totalAssets', 'TOTAL_ASSETS');
  pushBalance('totalLiabilities', 'TOTAL_LIABILITIES');
  pushBalance('totalEquity', 'TOTAL_EQUITY');
  pushBalance('cashAndCashEquivalents', 'MONETARYFUNDS');

  return {
    id: periodId,
    fiscalYear: fy,
    fiscalPeriodType: periodType,
    periodStartOn,
    periodEndOn: cum.reportDate,
    ...(cum.noticeDate ? { publishedAt: toDateTime(cum.noticeDate) } : {}),
    reportingScope: 'consolidated',
    accountingBasis: 'CAS',
    revision: { kind: 'original' },
    facts,
  };
}

function pushComputed(
  facts: FinancialFact[],
  metricCode: FinancialFact['metricCode'],
  a: FinancialFact,
  b: FinancialFact,
  formula: string,
  label: string,
): void {
  const exists = facts.some(
    (fact) => fact.metricCode === metricCode && fact.derivation.kind === 'computed',
  );
  if (exists) return;
  facts.push({
    id: `${a.id}:computed:${metricCode}`,
    metricCode,
    value: decimalSubtract(a.value, b.value),
    unit: a.unit,
    currency: a.currency,
    scale: 1,
    periodKind: a.periodKind,
    periodStartOn: a.periodStartOn,
    periodEndOn: a.periodEndOn,
    accumulation: a.accumulation,
    accountingBasis: a.accountingBasis,
    reportingScope: a.reportingScope,
    derivation: { kind: 'computed', formula, inputFactIds: [a.id, b.id] },
    provenance: {
      provider: PROVIDER,
      sourceNature: 'aggregated_structured',
      qualityTier: 'B',
      sourceUrl: a.provenance.sourceUrl,
      sourceField: `computed:${label}:${formula}`,
      snapshotId: a.provenance.snapshotId,
      retrievedAt: a.provenance.retrievedAt,
    },
  });
}

function toDateTime(date: string): string {
  return date.length === 10 ? `${date}T00:00:00.000Z` : date;
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
