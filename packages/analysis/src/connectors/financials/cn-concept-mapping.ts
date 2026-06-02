/**
 * Eastmoney datacenter-web 三表字段 → FinancialsBundle 字段映射。
 *
 * RFC financials Phase 2 (CN, 2026-05-25)。
 *
 * 三个 Eastmoney 端点（datacenter-web/api/data/v1/get?reportName=X）：
 *   RPT_DMSK_FN_INCOME    — 利润表
 *   RPT_DMSK_FN_BALANCE   — 资产负债表
 *   RPT_DMSK_FN_CASHFLOW  — 现金流量表
 *
 * 与 SEC EDGAR XBRL 不同点：
 *   - Eastmoney 返回 **宽表**（每行一个 period），不像 XBRL 是 EAV
 *   - Period 是 **累计期**：003=Q1, 002=半年(累计), 004=九月(累计), 001=年报
 *     需要 connector 派生 standalone Q（H1-Q1=Q2, 9m-H1=Q3, FY-9m=Q4）
 *   - 字段都是中文会计准则 (CN GAAP) 概念，不像 us-gaap 那么碎片化，单一字段即可
 *   - 单位统一 CNY（人民币）
 *
 * 字段映射依据：Eastmoney 公开 datacenter API，2026-05 实测 600519 茅台 + 多家 A 股。
 */

/** Eastmoney 利润表字段映射 → FinancialsBundle.income。 */
export const INCOME_FIELDS = {
  revenue: 'TOTAL_OPERATE_INCOME', // 营业总收入
  costOfRevenue: 'OPERATE_COST', // 营业成本
  // grossProfit 不直接给，由 connector 派生 = revenue - costOfRevenue
  operatingIncome: 'OPERATE_PROFIT', // 营业利润
  netIncome: 'PARENT_NETPROFIT', // 归属母公司净利润
  // eps：单独从 RPT_LICO_FN_CPD 补 (BASIC_EPS / DEDUCT_BASIC_EPS)
} as const;

/**
 * plan-v2 Wave 1.4 — additional 利润表 fields kept on the row but not in
 * the public FinancialsBundle.income schema. Consumed by the
 * `extraIncomeFields` extension surface (see CnExtraFinancials below).
 */
export const INCOME_FIELDS_EXTRA = {
  totalOperateCost: 'TOTAL_OPERATE_COST', // 营业总成本
  sellExpense: 'SALE_EXPENSE', // 销售费用
  manageExpense: 'MANAGE_EXPENSE', // 管理费用
  researchExpense: 'RESEARCH_EXPENSE', // 研发费用
  financeExpense: 'FINANCE_EXPENSE', // 财务费用
  totalProfit: 'TOTAL_PROFIT', // 利润总额
  incomeTax: 'INCOME_TAX', // 所得税
  totalCompreIncome: 'TOTAL_COMPRE_INCOME', // 综合收益总额
  basicEps: 'BASIC_EPS', // 基本每股收益（已迁，部分股票 9501 返回，需 fallback）
  dilutedEps: 'DILUTED_EPS', // 稀释每股收益
} as const;

/** Eastmoney 资产负债表字段映射。 */
export const BALANCE_FIELDS = {
  totalAssets: 'TOTAL_ASSETS', // 资产总计
  totalLiabilities: 'TOTAL_LIABILITIES', // 负债合计
  totalStockholdersEquity: 'TOTAL_EQUITY', // 所有者权益合计
  cashAndCashEquivalents: 'MONETARYFUNDS', // 货币资金
  // longTermDebt：A 股没有完全对等的统一字段；非金融企业一般填 LONG_LOAN（长期借款）
  longTermDebt: 'LONG_LOAN', // 长期借款（金融企业字段不同，留 undefined）
} as const;

export const BALANCE_FIELDS_EXTRA = {
  accountsReceivable: 'ACCOUNTS_RECE', // 应收账款
  inventory: 'INVENTORY', // 存货
  fixedAsset: 'FIXED_ASSET', // 固定资产
  intangibleAsset: 'INTANGIBLE_ASSET', // 无形资产
  shortLoan: 'SHORT_LOAN', // 短期借款
  accountsPayable: 'ACCOUNTS_PAYABLE', // 应付账款
  accountsAdvance: 'ADVANCE_RECEIVABLES', // 预收账款（合同负债）
  surplusReserve: 'SURPLUS_RESERVE', // 盈余公积
  unassignedProfit: 'UNASSIGN_RPOFIT', // 未分配利润（注意 typo, Eastmoney 自家拼错）
  parentEquity: 'TOTAL_PARENT_EQUITY', // 归属于母公司股东权益合计
  minorityEquity: 'MINORITY_EQUITY', // 少数股东权益
  // plan-v2: extras required by red-flags + compute layer (parity with US XBRL).
  goodwill: 'GOODWILL', // 商誉 (drives goodwillConcentration red-flag)
  totalCurrentAssets: 'TOTAL_CURRENT_ASSETS', // 流动资产合计 (currentRatio)
  totalCurrentLiabilities: 'TOTAL_CURRENT_LIAB', // 流动负债合计 (currentRatio)
} as const;

/** Eastmoney 现金流量表字段映射。 */
export const CASHFLOW_FIELDS = {
  operatingCashFlow: 'NETCASH_OPERATE', // 经营活动产生的现金流量净额
  investingCashFlow: 'NETCASH_INVEST', // 投资活动产生的现金流量净额
  financingCashFlow: 'NETCASH_FINANCE', // 筹资活动产生的现金流量净额
  capitalExpenditures: 'CONSTRUCT_LONG_ASSET', // 购建固定资产、无形资产和其他长期资产支付的现金
  // freeCashFlow 由 connector 派生 = OCF - CapEx
} as const;

export const CASHFLOW_FIELDS_EXTRA = {
  saleService: 'SALES_SERVICES', // 销售商品、提供劳务收到的现金
  tax: 'PAY_ALL_TAX', // 支付的各项税费
  invest: 'INVEST_INCOME', // 取得投资收益收到的现金
  paymentDividend: 'ASSIGN_DIVIDEND_PORFIT', // 分配股利、利润或偿付利息支付的现金
  paymentLoan: 'RECEIVE_LOAN_CASH', // 取得借款收到的现金
  cashBeginPeriod: 'BEGIN_CCE', // 期初现金及现金等价物余额
  cashEndPeriod: 'END_CCE', // 期末现金及现金等价物余额
  netIncreaseCash: 'CCE_ADD', // 现金及现金等价物净增加额
  // D&A 三件套 — 合计后填入 cashFlow.depreciationAndAmortization。
  faDepreciation: 'FA_IR_DEPR', // 固定资产折旧、油气资产折耗、生产性生物资产折旧
  iaAmortization: 'IA_AMORTIZE', // 无形资产摊销
  lpeAmortization: 'LPE_AMORTIZE', // 长期待摊费用摊销
} as const;

/**
 * `DATE_TYPE_CODE` enum from Eastmoney datacenter (also called 报告类型).
 *   '001' = annual report (FY, period end 12-31)
 *   '002' = half-year report (H1, cumulative Jan–Jun)
 *   '003' = first-quarter report (Q1, period Jan–Mar)
 *   '004' = third-quarter report (nine-months cumulative Jan–Sep)
 */
export type DateTypeCode = '001' | '002' | '003' | '004';

/**
 * Eastmoney row shape — only the fields we use. The API returns many more
 * columns; downstream `pickField` tolerates missing/`null` so this typing
 * stays minimal.
 */
export interface EastmoneyFinancialsRow {
  SECURITY_CODE: string;
  REPORT_DATE: string; // 'YYYY-MM-DD HH:mm:ss'
  NOTICE_DATE?: string;
  DATE_TYPE_CODE: DateTypeCode;
  REPORT_TYPE_CODE?: string; // '001' = first-issue, others = restatement
  DATA_STATE?: string;
  [field: string]: unknown;
}

/**
 * Read a numeric field; returns `null` when missing / null / NaN. Eastmoney
 * sometimes returns `null` for inapplicable line items (e.g. financial-only
 * fields on non-financials).
 */
export function pickNumber(row: EastmoneyFinancialsRow, field: string): number | null {
  const v = row[field];
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return null;
  return n;
}
