/**
 * XBRL concept mapping v2 — structured-first earnings（§8.1）。
 *
 * 与 v1（concept-mapping.ts）的差异：
 * - 双 taxonomy：`us-gaap` + `ifrs-full`（20-F/6-K 外国发行人）；
 * - 每个 canonical metric 使用有序 concept 集（同 taxonomy 内按优先级）；
 * - EPS 拆成 basic / diluted 两个 metric；
 * - 新增 `netIncomeAttrib`（归母净利润）；
 * - fact 级 provenance：concept 名记入 sourceField，accession/filed 保留。
 *
 * companyfacts JSON 本身不包含带 dimensions 的 fact（SEC API 排除维度化事实）；
 * 若未来 schema 携带 `dimensions` 字段，connector 防御性拒绝（核心 consolidated
 * fact 不允许 segment/axis 维度）。
 */

export type XbrlTaxonomy = 'us-gaap' | 'ifrs-full';

export type V2MetricCode =
  | 'revenue'
  | 'costOfRevenue'
  | 'grossProfit'
  | 'operatingIncome'
  | 'netIncome'
  | 'netIncomeAttrib'
  | 'epsBasic'
  | 'epsDiluted'
  | 'operatingCashFlow'
  | 'capitalExpenditures'
  | 'totalAssets'
  | 'totalLiabilities'
  | 'totalEquity'
  | 'cashAndCashEquivalents';

/** 每个 canonical metric 的有序 concept 集；靠前优先。 */
export const V2_CONCEPTS: Record<
  V2MetricCode,
  { 'us-gaap': readonly string[]; 'ifrs-full': readonly string[] }
> = {
  revenue: {
    'us-gaap': [
      'RevenueFromContractWithCustomerExcludingAssessedTax',
      'Revenues',
      'SalesRevenueNet',
      'RevenueFromContractWithCustomerIncludingAssessedTax',
      'SalesRevenueGoodsNet',
    ],
    'ifrs-full': ['Revenue', 'RevenueFromContractsWithCustomers'],
  },
  costOfRevenue: {
    'us-gaap': ['CostOfRevenue', 'CostOfGoodsAndServicesSold', 'CostOfGoodsSold'],
    'ifrs-full': ['CostOfSales', 'CostOfGoodsSold'],
  },
  grossProfit: {
    'us-gaap': ['GrossProfit'],
    'ifrs-full': ['GrossProfit'],
  },
  operatingIncome: {
    'us-gaap': ['OperatingIncomeLoss'],
    'ifrs-full': ['ProfitLossFromOperatingActivities', 'OperatingProfitLoss'],
  },
  netIncome: {
    'us-gaap': ['NetIncomeLoss', 'ProfitLoss'],
    'ifrs-full': ['ProfitLoss'],
  },
  netIncomeAttrib: {
    'us-gaap': ['NetIncomeLossAttributableToParent', 'ProfitLossAttributableToParent'],
    'ifrs-full': ['ProfitLossAttributableToOwnersOfParent'],
  },
  epsBasic: {
    'us-gaap': ['EarningsPerShareBasic'],
    'ifrs-full': ['EarningsPerShareBasic', 'EarningsPerShareBasicAndDiluted'],
  },
  epsDiluted: {
    'us-gaap': ['EarningsPerShareDiluted'],
    'ifrs-full': ['EarningsPerShareDiluted', 'EarningsPerShareBasicAndDiluted'],
  },
  operatingCashFlow: {
    'us-gaap': ['NetCashProvidedByUsedInOperatingActivities'],
    'ifrs-full': ['NetCashFlowsFromUsedInOperatingActivities'],
  },
  capitalExpenditures: {
    'us-gaap': ['PaymentsToAcquirePropertyPlantAndEquipment', 'PaymentsToAcquireProductiveAssets'],
    'ifrs-full': ['PaymentsToAcquirePropertyPlantAndEquipment'],
  },
  totalAssets: {
    'us-gaap': ['Assets'],
    'ifrs-full': ['Assets'],
  },
  totalLiabilities: {
    'us-gaap': ['Liabilities'],
    'ifrs-full': ['Liabilities'],
  },
  totalEquity: {
    'us-gaap': [
      'StockholdersEquity',
      'StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest',
    ],
    'ifrs-full': ['Equity', 'EquityAttributableToOwnersOfParent'],
  },
  cashAndCashEquivalents: {
    'us-gaap': ['CashAndCashEquivalentsAtCarryingValue', 'Cash'],
    'ifrs-full': ['CashAndCashEquivalents'],
  },
};

/** 派生 metric（不进 concept 表，由 connector 确定性计算）。 */
export const V2_COMPUTED_METRICS = ['freeCashFlow', 'grossProfit'] as const;

/** companyfacts 单条 fact（本地子集类型，含防御性 dimensions 字段）。 */
export interface V2XbrlFactEntry {
  start?: string;
  end: string;
  val: number;
  accn?: string;
  fy: number;
  fp: string;
  form: string;
  filed: string;
  frame?: string;
  dimensions?: Record<string, unknown>;
}

export interface V2XbrlConcept {
  label?: string;
  description?: string;
  units: Record<string, V2XbrlFactEntry[]>;
}

export interface V2XbrlCompanyFacts {
  cik: number;
  entityName?: string;
  facts?: {
    'us-gaap'?: Record<string, V2XbrlConcept>;
    'ifrs-full'?: Record<string, V2XbrlConcept>;
    dei?: Record<string, V2XbrlConcept>;
  };
}

export function hasDimensions(entry: V2XbrlFactEntry): boolean {
  return Boolean(entry.dimensions && Object.keys(entry.dimensions).length > 0);
}

/** 判断该 taxonomy 是否真的含公司数据（以 revenue 候选集为准）。 */
export function taxonomyHasRevenue(
  concepts: Record<string, V2XbrlConcept> | undefined,
  taxonomy: XbrlTaxonomy,
): boolean {
  if (!concepts) return false;
  for (const name of V2_CONCEPTS.revenue[taxonomy]) {
    const concept = concepts[name];
    if (!concept) continue;
    for (const entries of Object.values(concept.units)) {
      if (entries.some((entry) => !hasDimensions(entry))) return true;
    }
  }
  return false;
}

export function pickTaxonomy(facts: V2XbrlCompanyFacts['facts']): XbrlTaxonomy | null {
  if (taxonomyHasRevenue(facts?.['us-gaap'], 'us-gaap')) return 'us-gaap';
  if (taxonomyHasRevenue(facts?.['ifrs-full'], 'ifrs-full')) return 'ifrs-full';
  return null;
}
