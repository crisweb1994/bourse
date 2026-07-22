/**
 * us-gaap concept → FinancialsBundle 字段的优先级映射。
 *
 * RFC §3.3：不同公司对同一指标用不同 us-gaap concept（ASC 606 改革 / 行业差异 /
 * 旧公司沿用旧 concept），每个 line item 维护 alternative 列表按优先级查找。
 * Phase 1 覆盖 ~25 个 mainstream concept，目标 90% 大盘股；未覆盖的（银行
 * InterestIncomeOperating / REIT FFO / 保险 ULAE 等）落空 → dim 走 LLM webSearch
 * fallback。
 *
 * Concept 选择依据：SEC XBRL Taxonomy 2024 + GitHub `sec-edgar-xbrl` 社区项目
 * 经验列表。如发现某主流公司缺关键字段，加 alternative 到对应数组前面。
 */

// ============================================================================
// XBRL companyfacts JSON 内部 shape (subset，只描述用到的)
// ============================================================================

/**
 * 单个 fact 数据点（一个 concept × 一个 period × 一个 unit 对应一条）。
 * SEC XBRL companyfacts schema：https://www.sec.gov/edgar/sec-api-documentation
 */
export interface XbrlFactEntry {
  /** Period 结束日 ISO 'YYYY-MM-DD'。 */
  end: string;
  /** Period 开始日 ISO 'YYYY-MM-DD'。Income/CashFlow 必有；balance 是时点（end 等于 start 概念）。 */
  start?: string;
  val: number;
  /** Fiscal year (numeric)。 */
  fy: number;
  /** Fiscal period: FY (annual) 或 Q1/Q2/Q3/Q4 (quarterly)。 */
  fp: 'FY' | 'Q1' | 'Q2' | 'Q3' | 'Q4';
  /** Form 类型 '10-K' / '10-Q' / '20-F' / '8-K' / 'CT ORDER' 等。 */
  form: string;
  /** Filing 提交日 ISO 'YYYY-MM-DD'，重述报表用这个排序取最新。 */
  filed: string;
  /** Accession number — 唯一定位到某份 filing。 */
  accn?: string;
  /** SEC frame identifier (e.g. 'CY2024Q3I')，不参与 Phase 1 逻辑。 */
  frame?: string;
}

export interface XbrlConcept {
  label?: string;
  description?: string;
  /** Keyed by unit string: 'USD' / 'shares' / 'USD/shares' / 'pure' / etc. */
  units: Record<string, XbrlFactEntry[]>;
}

/** XBRL companyfacts JSON top-level shape (subset). */
export interface XbrlCompanyFacts {
  cik: number;
  entityName?: string;
  facts: {
    'us-gaap'?: Record<string, XbrlConcept>;
    dei?: Record<string, XbrlConcept>;
    'ifrs-full'?: Record<string, XbrlConcept>;
  };
}

// ============================================================================
// Concept alternative lists（每个 LineItem 字段一个数组，按优先级降序）
// ============================================================================

export const INCOME_CONCEPTS = {
  revenue: [
    'Revenues',
    'RevenueFromContractWithCustomerExcludingAssessedTax',
    'RevenueFromContractWithCustomerIncludingAssessedTax',
    'SalesRevenueNet',
    'SalesRevenueGoodsNet',
  ],
  costOfRevenue: [
    'CostOfRevenue',
    'CostOfGoodsAndServicesSold',
    'CostOfGoodsSold',
  ],
  grossProfit: [
    'GrossProfit',
  ],
  operatingIncome: [
    'OperatingIncomeLoss',
  ],
  netIncome: [
    'NetIncomeLoss',
    'ProfitLoss',
  ],
  eps: [
    'EarningsPerShareDiluted',
    'EarningsPerShareBasic',
  ],
} as const satisfies Record<string, readonly string[]>;

export const BALANCE_CONCEPTS = {
  totalAssets: [
    'Assets',
  ],
  totalLiabilities: [
    'Liabilities',
  ],
  totalStockholdersEquity: [
    'StockholdersEquity',
    'StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest',
  ],
  cashAndCashEquivalents: [
    'CashAndCashEquivalentsAtCarryingValue',
    'Cash',
  ],
  longTermDebt: [
    'LongTermDebtNoncurrent',
    'LongTermDebt',
  ],
} as const satisfies Record<string, readonly string[]>;

export const CASHFLOW_CONCEPTS = {
  operatingCashFlow: [
    'NetCashProvidedByUsedInOperatingActivities',
  ],
  investingCashFlow: [
    'NetCashProvidedByUsedInInvestingActivities',
  ],
  financingCashFlow: [
    'NetCashProvidedByUsedInFinancingActivities',
  ],
  capitalExpenditures: [
    'PaymentsToAcquirePropertyPlantAndEquipment',
    'PaymentsToAcquireProductiveAssets',
  ],
  // freeCashFlow 不是 XBRL 直接概念，由 connector 派生：OCF - CapEx
} as const satisfies Record<string, readonly string[]>;

// ============================================================================
// plan-v2 Wave 1.5 — extended SEC XBRL concept map (~80 concepts total).
//
// data.md verified all 8 previously-missing concepts return YES from SEC
// company-facts. This block exposes them as additional alternatives —
// compute layer & red-flag rules consume them directly; existing
// FinancialsBundle pipelines stay unaffected (additive).
//
// Selection criteria for inclusion:
//   - Concept used by ≥50% of S&P500 filers (so it actually exists on
//     most snapshots)
//   - Maps to a metric used by either compute/ or red-flags rules
//   - Has a single, unambiguous interpretation (avoid generic
//     `DerivativeLiabilities` and similar pre-filter buckets)
// ============================================================================

export const INCOME_CONCEPTS_EXTRA = {
  researchAndDevelopment: ['ResearchAndDevelopmentExpense'],
  sellingGeneralAdministrative: [
    'SellingGeneralAndAdministrativeExpense',
    'GeneralAndAdministrativeExpense',
  ],
  interestExpense: ['InterestExpense', 'InterestExpenseDebt'],
  incomeTaxExpense: ['IncomeTaxExpenseBenefit'],
  earningsBeforeTax: ['IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest'],
  comprehensiveIncome: ['ComprehensiveIncomeNetOfTax'],
  weightedAverageBasicShares: ['WeightedAverageNumberOfSharesOutstandingBasic'],
  weightedAverageDilutedShares: ['WeightedAverageNumberOfDilutedSharesOutstanding'],
  commonStockSharesOutstanding: ['CommonStockSharesOutstanding'],
  earningsPerShareBasic: ['EarningsPerShareBasic'],
  earningsPerShareDiluted: ['EarningsPerShareDiluted'],
} as const satisfies Record<string, readonly string[]>;

export const BALANCE_CONCEPTS_EXTRA = {
  accountsReceivable: ['AccountsReceivableNetCurrent', 'ReceivablesNetCurrent'],
  inventory: ['InventoryNet'],
  goodwill: ['Goodwill'],
  intangibleAssets: ['IntangibleAssetsNetExcludingGoodwill'],
  propertyPlantEquipmentNet: ['PropertyPlantAndEquipmentNet'],
  currentAssets: ['AssetsCurrent'],
  currentLiabilities: ['LiabilitiesCurrent'],
  shortTermDebt: [
    'ShortTermBorrowings',
    'CommercialPaper',
    'LongTermDebtAndShortTermDebtCurrentMaturities',
  ],
  accountsPayable: ['AccountsPayableCurrent'],
  retainedEarnings: ['RetainedEarningsAccumulatedDeficit'],
  commonStockValue: ['CommonStockValue'],
  treasuryStock: ['TreasuryStockValue'],
  preferredStock: ['PreferredStockValue'],
} as const satisfies Record<string, readonly string[]>;

export const CASHFLOW_CONCEPTS_EXTRA = {
  depreciationAndAmortization: [
    'DepreciationDepletionAndAmortization',
    'DepreciationAndAmortization',
  ],
  stockBasedCompensation: [
    'ShareBasedCompensation',
    'StockBasedCompensation',
  ],
  paymentsOfDividends: ['PaymentsOfDividends', 'PaymentsOfDividendsCommonStock'],
  repurchaseOfCommonStock: ['PaymentsForRepurchaseOfCommonStock'],
  proceedsFromIssuanceOfDebt: ['ProceedsFromIssuanceOfLongTermDebt'],
  repaymentsOfDebt: ['RepaymentsOfLongTermDebt'],
  changeInAccountsReceivable: ['IncreaseDecreaseInAccountsReceivable'],
  changeInInventory: ['IncreaseDecreaseInInventories'],
  changeInAccountsPayable: ['IncreaseDecreaseInAccountsPayable'],
} as const satisfies Record<string, readonly string[]>;

// ============================================================================
// Lookup helpers
// ============================================================================

/**
 * 在 us-gaap concept 表里按 alternative 列表查找第一个存在的 concept。
 * 找不到返回 undefined（line item 留 undefined）。
 */
export function findConcept(
  usGaap: Record<string, XbrlConcept> | undefined,
  alternatives: readonly string[],
): XbrlConcept | undefined {
  if (!usGaap) return undefined;
  for (const name of alternatives) {
    const concept = usGaap[name];
    if (concept) return concept;
  }
  return undefined;
}

/**
 * 给定 concept + (fy, fp)，挑出对应的 fact entry（处理重述：多条同 period 时
 * 按 filed 降序取最新）。返回 unit + entry，由 caller 转 LineItem。
 *
 * 注意：concept.units 通常只有一个 key（如 'USD'），但 EPS 可能 'USD/shares'，
 * shares 类是 'shares'。我们不预设 unit，第一个有匹配数据的 unit 胜出。
 */
export function pickFactForPeriod(
  concept: XbrlConcept,
  target: { fy: number; fp: 'FY' | 'Q1' | 'Q2' | 'Q3' | 'Q4' },
): { unit: string; entry: XbrlFactEntry } | undefined {
  for (const [unit, entries] of Object.entries(concept.units)) {
    const matches = entries.filter((e) => e.fy === target.fy && e.fp === target.fp);
    if (matches.length === 0) continue;
    // A single 10-Q repeats comparative periods and may expose both discrete
    // and YTD values under the same (fy, fp, filed). Prefer the latest filing,
    // then the latest period end, then a framed/shorter discrete duration.
    const latest = [...matches].sort(compareCurrentFact)[0];
    return { unit, entry: latest };
  }
  return undefined;
}

/** Selects the current cumulative duration fact for cash-flow differencing. */
export function pickCumulativeFactForPeriod(
  concept: XbrlConcept,
  target: { fy: number; fp: 'FY' | 'Q1' | 'Q2' | 'Q3' | 'Q4' },
): { unit: string; entry: XbrlFactEntry } | undefined {
  for (const [unit, entries] of Object.entries(concept.units)) {
    const matches = entries.filter((entry) => entry.fy === target.fy && entry.fp === target.fp);
    if (matches.length === 0) continue;
    const currentEnd = [...matches].sort(compareCurrentFact)[0]?.end;
    const current = matches
      .filter((entry) => entry.end === currentEnd)
      .sort((a, b) => {
        const filed = b.filed.localeCompare(a.filed);
        if (filed !== 0) return filed;
        // Earlier start means a longer fiscal-year-to-date duration.
        return (a.start ?? a.end).localeCompare(b.start ?? b.end);
      })[0];
    return current ? { unit, entry: current } : undefined;
  }
  return undefined;
}

export function compareCurrentFact(a: XbrlFactEntry, b: XbrlFactEntry): number {
  const filed = b.filed.localeCompare(a.filed);
  if (filed !== 0) return filed;
  const end = b.end.localeCompare(a.end);
  if (end !== 0) return end;
  const framed = Number(Boolean(b.frame)) - Number(Boolean(a.frame));
  if (framed !== 0) return framed;
  return (b.start ?? '').localeCompare(a.start ?? '');
}
