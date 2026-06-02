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
import {
  createInMemoryCikLookup,
  type CikLookup,
} from '../filings/cik-lookup';
import {
  BALANCE_CONCEPTS,
  BALANCE_CONCEPTS_EXTRA,
  CASHFLOW_CONCEPTS,
  CASHFLOW_CONCEPTS_EXTRA,
  INCOME_CONCEPTS,
  INCOME_CONCEPTS_EXTRA,
  pickFactForPeriod,
  type XbrlCompanyFacts,
  type XbrlConcept,
  type XbrlFactEntry,
} from './concept-mapping';
import { deriveTTM } from './ttm-derivation';

/**
 * SEC EDGAR XBRL Company Facts connector — RFC §3.3。
 *
 * Endpoint: https://data.sec.gov/api/xbrl/companyfacts/CIK{10-digit}.json
 * 一次返回该公司全历史 XBRL facts，按 us-gaap concept 分组。
 *
 * 流程：
 * 1. ticker → CIK (复用 connectors/filings/cik-lookup)
 * 2. HTTP GET companyfacts JSON
 * 3. 对每个 (LineItem field × FY 或 Q period) 调 concept-mapping 提取
 * 4. 派生 TTM (调 ttm-derivation)
 * 5. 返回 FinancialsBundle
 *
 * 失败语义：
 * - 公司未在 SEC 备案（外国私募 / pink sheet）→ `data: null`，无 warning
 * - CIK API 失败 / 网络 → `data: null` + warning SOURCE_UNAVAILABLE
 * - JSON 拿到但 us-gaap 字段全空 → `data: null` + warning PARTIAL_DATA
 * - 非 US 市场 → `data: null` + warning UNSUPPORTED_MARKET
 */

const PROVIDER = 'sec-edgar-xbrl';
const COMPANYFACTS_URL = 'https://data.sec.gov/api/xbrl/companyfacts';
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_YEARS = 5;

export interface SecEdgarXbrlOptions {
  /** SEC 强制要求 contact UA。Format: `App Name contact@example.com`。 */
  userAgent: string;
  /** 测试用 override，默认走 in-memory CIK lookup with same UA。 */
  cikLookup?: CikLookup;
  /** 测试用 FetchLike。 */
  fetchLike?: FetchLike;
  timeoutMs?: number;
  /** 测试用注入"当前时间"。 */
  now?: () => Date;
}

export function createSecEdgarXbrlFinancialsConnector(
  options: SecEdgarXbrlOptions,
): FinancialsPort {
  if (!options.userAgent?.trim()) {
    throw new Error(
      'SecEdgarXbrl connector requires a non-empty userAgent (SEC compliance).',
    );
  }
  const cikLookup =
    options.cikLookup ??
    createInMemoryCikLookup({
      userAgent: options.userAgent,
      ...(options.fetchLike ? { fetchLike: options.fetchLike } : {}),
    });
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = options.now ?? (() => new Date());

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
      if (parsed.market !== 'US') {
        return failure(
          retrievedAt,
          'UNSUPPORTED_MARKET',
          `sec-edgar-xbrl only handles US issuers; got ${parsed.market}`,
        );
      }

      const fetchLike = resolveFetch(ctx, options);

      // ---- CIK lookup ----
      let cik: { cik: string; name: string } | null;
      try {
        cik = await cikLookup.resolve(parsed.symbol, ctx);
      } catch (err) {
        const message = (err as Error)?.message ?? String(err);
        return failure(retrievedAt, 'SOURCE_UNAVAILABLE', `CIK lookup failed: ${message}`, message);
      }
      if (!cik) {
        return failure(retrievedAt, 'INVALID_INSTRUMENT', `Unknown SEC ticker: ${parsed.symbol}`);
      }

      // ---- HTTP fetch companyfacts ----
      const url = `${COMPANYFACTS_URL}/CIK${cik.cik}.json`;

      // `withTimeout` yields either the parsed facts (`{ facts }`) or an early
      // ResearchResult (`{ envelope }`) — 404 not-filed / non-ok HTTP — that we
      // propagate verbatim.
      type FetchOutcome =
        | { facts: XbrlCompanyFacts }
        | { envelope: ResearchResult<FinancialsBundle | null> };
      let outcome: FetchOutcome;
      try {
        outcome = await withTimeout<FetchOutcome>(ctx, timeoutMs, async (signal) => {
          const res = await fetchLike(url, {
            headers: { 'User-Agent': options.userAgent, Accept: 'application/json' },
            signal,
          });
          if (res.status === 404) {
            // 公司无 XBRL 备案（小公司 / 外国发行人）
            return {
              envelope: {
                schemaVersion: RESEARCH_SCHEMA_VERSION,
                data: null,
                citations: [],
                freshness: [{ provider: PROVIDER, asOf: retrievedAt, retrievedAt, stale: false }],
                warnings: [],
              },
            };
          }
          if (!res.ok) {
            return {
              envelope: failure(
                retrievedAt,
                res.status === 403 ? 'AUTH_REQUIRED' : 'SOURCE_UNAVAILABLE',
                `SEC XBRL companyfacts HTTP ${res.status}`,
                `HTTP ${res.status}`,
              ),
            };
          }
          return { facts: (await res.json()) as XbrlCompanyFacts };
        });
      } catch (err) {
        const message = (err as Error)?.message ?? String(err);
        return failure(retrievedAt, 'SOURCE_UNAVAILABLE', `SEC XBRL fetch error: ${message}`, message);
      }
      if ('envelope' in outcome) {
        return outcome.envelope;
      }
      const facts: XbrlCompanyFacts = outcome.facts;

      // ---- Parse to FinancialsBundle ----
      const usGaap = facts.facts?.['us-gaap'];
      if (!usGaap) {
        return failure(retrievedAt, 'PARTIAL_DATA', `XBRL companyfacts has no us-gaap for ${parsed.symbol}`);
      }

      const years = input.years ?? DEFAULT_YEARS;
      const deriveTTMFlag = input.deriveTTM ?? true;

      const { periods: rawPeriods, currency } = extractPeriods(usGaap, years);

      if (rawPeriods.length === 0) {
        return failure(retrievedAt, 'PARTIAL_DATA', `XBRL companyfacts for ${parsed.symbol} contained no usable FY/Q periods`);
      }

      // ---- TTM derivation ----
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

      const bundle: FinancialsBundle = {
        periods: finalPeriods,
        currency,
        sourceUrl: url,
        retrievedAt,
        provider: PROVIDER,
        qualityTier: 'A',
        ...(ttmSkippedReason ? { ttmSkippedReason } : {}),
      };

      const citation: ResearchCitation = {
        title: `SEC EDGAR Company Facts: ${cik.name}`,
        url,
        sourceType: 'FILING',
        provider: PROVIDER,
        retrievedAt,
        qualityTier: 'A',
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
// Period extraction
// ============================================================================

interface ExtractResult {
  periods: FinancialsPeriodEntry[];
  currency: string;
}

/**
 * 从 us-gaap concepts 抽出 FY/Q periods。
 *
 * 策略：
 * 1. 用 revenue concept 当 anchor，列出该公司有数据的 (fy, fp) 组合
 * 2. 按 (fy desc, fp desc) 选最近 N 年的 FY + 最近 4 个 Q
 * 3. 对每个 period，提取所有 LineItem 字段
 * 4. FCF 派生：OCF - CapEx
 */
function extractPeriods(
  usGaap: Record<string, XbrlConcept>,
  years: number,
): ExtractResult {
  // Anchor: enumerate (fy, fp) periods across ALL revenue alternatives.
  // Critical: companies that adopted ASC 606 carry BOTH the legacy `Revenues`
  // concept (limited old years) AND the modern `RevenueFromContractWithCustomer*`
  // concept (recent years). Picking only the first found alternative misses
  // the richer recent dataset. Union them here; `pickFactForPeriod` further
  // down handles per-period concept preference.
  const allPeriods: Array<{ fy: number; fp: 'FY' | 'Q1' | 'Q2' | 'Q3' | 'Q4'; entry: XbrlFactEntry; unit: string }> = [];
  let anchorFound = false;
  for (const name of INCOME_CONCEPTS.revenue) {
    const concept = usGaap[name];
    if (!concept) continue;
    anchorFound = true;
    for (const [unit, entries] of Object.entries(concept.units)) {
      for (const e of entries) {
        allPeriods.push({ fy: e.fy, fp: e.fp, entry: e, unit });
      }
    }
  }
  if (!anchorFound) {
    return { periods: [], currency: 'USD' };
  }

  // 推断主货币（取占多数的 unit；EPS 单位不算）
  const currency = inferCurrency(usGaap);

  // 按 (fy desc, fp desc) 排，对同 (fy, fp) 取 filed 最新
  const periodKey = (p: { fy: number; fp: string }) => `${p.fy}-${p.fp}`;
  const dedup = new Map<string, typeof allPeriods[number]>();
  for (const p of allPeriods) {
    const key = periodKey(p);
    const existing = dedup.get(key);
    if (!existing || p.entry.filed.localeCompare(existing.entry.filed) > 0) {
      dedup.set(key, p);
    }
  }
  const sorted = Array.from(dedup.values()).sort((a, b) => {
    if (b.fy !== a.fy) return b.fy - a.fy;
    return fpRank(b.fp) - fpRank(a.fp);
  });

  // 选最近 N 个 FY + 最近 4 个 Q
  const wantedFYs = sorted.filter((p) => p.fp === 'FY').slice(0, years);
  const wantedQs = sorted.filter((p) => p.fp !== 'FY').slice(0, 4);

  // TTM Q4 反推支持：当最新 FY 比最新 Q 老一年（即 anchor Q 所在 FY 的前一年），
  // TTM 派生需要那个前一年 FY 的 Q1+Q2+Q3 来反推 Q4。把这些"TTM helper Q"
  // 加进 selected set —— 它们不一定在 top-4 Q 里（被更新的 Q 挤掉了）。
  // 当 wantedFYs 为空时跳过，例：新上市公司只有几个 Q 没年报。
  const ttmHelperQs = pickTtmHelperQuarters(sorted, wantedFYs, wantedQs);

  // 把 selected periods 重新按 (fy desc, fp desc) 排（最新在前）
  // 去重：helper Q 可能和 wantedQs 撞，用 (fy, fp) key
  const selectedMap = new Map<string, typeof wantedFYs[number]>();
  for (const p of [...wantedFYs, ...wantedQs, ...ttmHelperQs]) {
    selectedMap.set(`${p.fy}-${p.fp}`, p);
  }
  const selected = Array.from(selectedMap.values()).sort((a, b) => {
    if (b.fy !== a.fy) return b.fy - a.fy;
    return fpRank(b.fp) - fpRank(a.fp);
  });

  // 对每个 period 提取所有 LineItem
  const periods: FinancialsPeriodEntry[] = selected.map((p) =>
    buildPeriodEntry(usGaap, p.fy, p.fp, p.entry),
  );
  return { periods, currency };
}

function fpRank(fp: 'FY' | 'Q1' | 'Q2' | 'Q3' | 'Q4'): number {
  return { FY: 5, Q4: 4, Q3: 3, Q2: 2, Q1: 1 }[fp];
}

/**
 * TTM helper Q selection — RFC financials Phase 1 follow-up (2026-05-25).
 *
 * For each FY in `wantedFYs`, if any of its Q1/Q2/Q3 is missing from the
 * top-4 Q window, pull it in from the full sorted list. This guarantees
 * deriveTTM has the Q1+Q2+Q3 needed to reverse-derive Q4 for that FY
 * (companies don't file 10-Q for Q4 → Q4 must be computed as
 *   FY - (Q1 + Q2 + Q3)).
 *
 * Without this, AAPL-style cadence (latest 4 Q's straddle two FYs and
 * skip a middle Q4) caused TTM to skip with "data gap".
 */
function pickTtmHelperQuarters(
  sorted: Array<{ fy: number; fp: 'FY' | 'Q1' | 'Q2' | 'Q3' | 'Q4'; entry: XbrlFactEntry; unit: string }>,
  wantedFYs: Array<{ fy: number; fp: 'FY' | 'Q1' | 'Q2' | 'Q3' | 'Q4'; entry: XbrlFactEntry; unit: string }>,
  wantedQs: Array<{ fy: number; fp: 'FY' | 'Q1' | 'Q2' | 'Q3' | 'Q4'; entry: XbrlFactEntry; unit: string }>,
): typeof sorted {
  if (wantedFYs.length === 0) return [];
  // Only the most recent 1–2 FYs participate in TTM reverse-derivation.
  // Older years aren't needed for any TTM window the latest anchor can hit.
  const fyTargets = wantedFYs.slice(0, 2);
  const present = new Set(wantedQs.map((q) => `${q.fy}-${q.fp}`));
  const helpers: typeof sorted = [];
  for (const fy of fyTargets) {
    for (const fp of ['Q1', 'Q2', 'Q3'] as const) {
      if (present.has(`${fy.fy}-${fp}`)) continue;
      const helper = sorted.find((s) => s.fy === fy.fy && s.fp === fp);
      if (helper) helpers.push(helper);
    }
  }
  return helpers;
}

function buildPeriodEntry(
  usGaap: Record<string, XbrlConcept>,
  fy: number,
  fp: 'FY' | 'Q1' | 'Q2' | 'Q3' | 'Q4',
  anchorEntry: XbrlFactEntry,
): FinancialsPeriodEntry {
  const income: IncomeStatement = {
    revenue: pickLineItem(usGaap, INCOME_CONCEPTS.revenue, fy, fp),
    costOfRevenue: pickLineItem(usGaap, INCOME_CONCEPTS.costOfRevenue, fy, fp),
    grossProfit: pickLineItem(usGaap, INCOME_CONCEPTS.grossProfit, fy, fp),
    operatingIncome: pickLineItem(usGaap, INCOME_CONCEPTS.operatingIncome, fy, fp),
    netIncome: pickLineItem(usGaap, INCOME_CONCEPTS.netIncome, fy, fp),
    eps: pickLineItem(usGaap, INCOME_CONCEPTS.eps, fy, fp),
    interestExpense: pickLineItem(usGaap, INCOME_CONCEPTS_EXTRA.interestExpense, fy, fp),
    incomeTaxExpense: pickLineItem(usGaap, INCOME_CONCEPTS_EXTRA.incomeTaxExpense, fy, fp),
    researchAndDevelopment: pickLineItem(
      usGaap,
      INCOME_CONCEPTS_EXTRA.researchAndDevelopment,
      fy,
      fp,
    ),
    sellingGeneralAdministrative: pickLineItem(
      usGaap,
      INCOME_CONCEPTS_EXTRA.sellingGeneralAdministrative,
      fy,
      fp,
    ),
    weightedAverageDilutedShares: pickLineItem(
      usGaap,
      INCOME_CONCEPTS_EXTRA.weightedAverageDilutedShares,
      fy,
      fp,
    ),
  };

  const balance: BalanceSheet = {
    totalAssets: pickLineItem(usGaap, BALANCE_CONCEPTS.totalAssets, fy, fp),
    totalLiabilities: pickLineItem(usGaap, BALANCE_CONCEPTS.totalLiabilities, fy, fp),
    totalStockholdersEquity: pickLineItem(
      usGaap,
      BALANCE_CONCEPTS.totalStockholdersEquity,
      fy,
      fp,
    ),
    cashAndCashEquivalents: pickLineItem(
      usGaap,
      BALANCE_CONCEPTS.cashAndCashEquivalents,
      fy,
      fp,
    ),
    longTermDebt: pickLineItem(usGaap, BALANCE_CONCEPTS.longTermDebt, fy, fp),
    accountsReceivable: pickLineItem(
      usGaap,
      BALANCE_CONCEPTS_EXTRA.accountsReceivable,
      fy,
      fp,
    ),
    inventory: pickLineItem(usGaap, BALANCE_CONCEPTS_EXTRA.inventory, fy, fp),
    goodwill: pickLineItem(usGaap, BALANCE_CONCEPTS_EXTRA.goodwill, fy, fp),
    intangibleAssets: pickLineItem(
      usGaap,
      BALANCE_CONCEPTS_EXTRA.intangibleAssets,
      fy,
      fp,
    ),
    currentAssets: pickLineItem(usGaap, BALANCE_CONCEPTS_EXTRA.currentAssets, fy, fp),
    currentLiabilities: pickLineItem(
      usGaap,
      BALANCE_CONCEPTS_EXTRA.currentLiabilities,
      fy,
      fp,
    ),
    shortTermDebt: pickLineItem(usGaap, BALANCE_CONCEPTS_EXTRA.shortTermDebt, fy, fp),
    accountsPayable: pickLineItem(
      usGaap,
      BALANCE_CONCEPTS_EXTRA.accountsPayable,
      fy,
      fp,
    ),
  };

  const cashFlow: CashFlow = {
    operatingCashFlow: pickLineItem(usGaap, CASHFLOW_CONCEPTS.operatingCashFlow, fy, fp),
    investingCashFlow: pickLineItem(usGaap, CASHFLOW_CONCEPTS.investingCashFlow, fy, fp),
    financingCashFlow: pickLineItem(usGaap, CASHFLOW_CONCEPTS.financingCashFlow, fy, fp),
    capitalExpenditures: pickLineItem(usGaap, CASHFLOW_CONCEPTS.capitalExpenditures, fy, fp),
    depreciationAndAmortization: pickLineItem(
      usGaap,
      CASHFLOW_CONCEPTS_EXTRA.depreciationAndAmortization,
      fy,
      fp,
    ),
    stockBasedCompensation: pickLineItem(
      usGaap,
      CASHFLOW_CONCEPTS_EXTRA.stockBasedCompensation,
      fy,
      fp,
    ),
    paymentsOfDividends: pickLineItem(
      usGaap,
      CASHFLOW_CONCEPTS_EXTRA.paymentsOfDividends,
      fy,
      fp,
    ),
    repurchaseOfCommonStock: pickLineItem(
      usGaap,
      CASHFLOW_CONCEPTS_EXTRA.repurchaseOfCommonStock,
      fy,
      fp,
    ),
  };
  // Derive FCF
  if (cashFlow.operatingCashFlow && cashFlow.capitalExpenditures) {
    cashFlow.freeCashFlow = {
      value: cashFlow.operatingCashFlow.value - cashFlow.capitalExpenditures.value,
      unit: cashFlow.operatingCashFlow.unit,
    };
  }

  return {
    fiscalPeriod: fp === 'FY' ? `FY${fy}` : `${fp}-FY${fy}`,
    kind: fp === 'FY' ? 'FY' : 'Q',
    fiscalYearEnd: anchorEntry.end,
    filed: anchorEntry.filed,
    formType: fp === 'FY' ? '10-K' : '10-Q',
    income,
    balance,
    cashFlow,
  };
}

function pickLineItem(
  usGaap: Record<string, XbrlConcept>,
  alternatives: readonly string[],
  fy: number,
  fp: 'FY' | 'Q1' | 'Q2' | 'Q3' | 'Q4',
): FinancialsLineItem | undefined {
  // Walk every alternative — ASC 606 era filers carry both legacy and
  // modern concepts, with different (fy, fp) coverage. First alternative
  // with a hit for this period wins (alternative priority preserved).
  for (const name of alternatives) {
    const concept = usGaap[name];
    if (!concept) continue;
    const picked = pickFactForPeriod(concept, { fy, fp });
    if (picked) return { value: picked.entry.val, unit: picked.unit };
  }
  return undefined;
}

function inferCurrency(usGaap: Record<string, XbrlConcept>): string {
  // 数 us-gaap 里非 EPS 概念的 unit 分布，最多者胜出。
  const counts = new Map<string, number>();
  for (const [conceptName, concept] of Object.entries(usGaap)) {
    if (conceptName.includes('EarningsPerShare') || conceptName.includes('Shares'))
      continue;
    for (const unit of Object.keys(concept.units)) {
      // 只统计 3 letter ISO currency 形式
      if (/^[A-Z]{3}$/.test(unit)) {
        counts.set(unit, (counts.get(unit) ?? 0) + 1);
      }
    }
  }
  let best = 'USD';
  let bestCount = 0;
  for (const [unit, count] of counts) {
    if (count > bestCount) {
      best = unit;
      bestCount = count;
    }
  }
  return best;
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
