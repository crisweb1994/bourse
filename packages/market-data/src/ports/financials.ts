import { z } from 'zod';
import type { ResearchResult } from '../contracts/result';
import type { ConnectorRunContext } from '../connectors/types';

/**
 * Financials Port — 三表 (income / balance / cashFlow) + 派生 TTM。
 *
 * Phase 1 (US, SEC EDGAR XBRL) + Phase 2 (CN, Eastmoney) 已落地；Phase 3
 * (HK, HKEX) 仍 backlog（improve.md 登记）。schema 不变。
 *
 * 设计要点：
 * - 单一 `fetchFinancials()` 入口，返回 `FinancialsBundle | null`。XBRL API
 *   一次返回全部 facts，拆 4 个 method 只增加 HTTP 次数。
 * - LineItem 只携带 `value + unit`；period 元信息（fiscalPeriod /
 *   fiscalYearEnd / filed / formType）放 PeriodEntry 上，避免每个数字重复。
 * - TTM (trailing twelve months) 由 connector 派生：bundle.periods[] 末尾加
 *   一个 `kind: 'TTM'` entry。income / cashFlow 走 4 个 Q 求和；balance 直接
 *   取最新 Q (balance 是时点不是区间)。
 * - TTM 边界 case (财年改 / 重述报表) → `ttmSkippedReason` 标注，正常 FY/Q
 *   数据照常返回。不静默给错值。
 * - `null` 返回：公司无 SEC 备案（外国私募 / pink sheet）。caller 应回退到
 *   LLM web_search 或跳过 financials 引用。
 */

// ============================================================================
// LineItem — 一个数字 + 单位
// ============================================================================

export const FinancialsLineItemSchema = z.object({
  value: z.number(),
  /**
   * 单位字符串。常见：'USD' / 'shares' / 'USD/shares' / 'pure' (比率)。
   * SEC XBRL 把单位带在每个 fact 上，这里保留原始字符串便于审计。
   */
  unit: z.string().min(1),
});
export type FinancialsLineItem = z.infer<typeof FinancialsLineItemSchema>;

// ============================================================================
// 三表 schema — 每个表 5-6 个 mainstream concept
// ============================================================================

export const IncomeStatementSchema = z.object({
  revenue: FinancialsLineItemSchema.optional(),
  costOfRevenue: FinancialsLineItemSchema.optional(),
  grossProfit: FinancialsLineItemSchema.optional(),
  operatingIncome: FinancialsLineItemSchema.optional(),
  netIncome: FinancialsLineItemSchema.optional(),
  /** Diluted EPS first, fallback to basic EPS. Unit 'USD/shares'. */
  eps: FinancialsLineItemSchema.optional(),
  // plan-v2 §5.1 — extended XBRL coverage. Populated from
  // INCOME_CONCEPTS_EXTRA by sec-edgar-xbrl; CN connector backfills what
  // Eastmoney exposes natively. Drives red-flags (interestCoverageLow)
  // and compute/financial-ratios.ts (real interestCoverage).
  interestExpense: FinancialsLineItemSchema.optional(),
  incomeTaxExpense: FinancialsLineItemSchema.optional(),
  researchAndDevelopment: FinancialsLineItemSchema.optional(),
  sellingGeneralAdministrative: FinancialsLineItemSchema.optional(),
  weightedAverageDilutedShares: FinancialsLineItemSchema.optional(),
});
export type IncomeStatement = z.infer<typeof IncomeStatementSchema>;

export const BalanceSheetSchema = z.object({
  totalAssets: FinancialsLineItemSchema.optional(),
  totalLiabilities: FinancialsLineItemSchema.optional(),
  totalStockholdersEquity: FinancialsLineItemSchema.optional(),
  cashAndCashEquivalents: FinancialsLineItemSchema.optional(),
  longTermDebt: FinancialsLineItemSchema.optional(),
  // plan-v2 §5.1 — extended XBRL coverage. Drives red-flags
  // (arOutpacing, goodwillConcentration) and compute (currentRatio,
  // quickRatio, working-capital ratios).
  accountsReceivable: FinancialsLineItemSchema.optional(),
  inventory: FinancialsLineItemSchema.optional(),
  goodwill: FinancialsLineItemSchema.optional(),
  intangibleAssets: FinancialsLineItemSchema.optional(),
  currentAssets: FinancialsLineItemSchema.optional(),
  currentLiabilities: FinancialsLineItemSchema.optional(),
  shortTermDebt: FinancialsLineItemSchema.optional(),
  accountsPayable: FinancialsLineItemSchema.optional(),
});
export type BalanceSheet = z.infer<typeof BalanceSheetSchema>;

export const CashFlowSchema = z.object({
  operatingCashFlow: FinancialsLineItemSchema.optional(),
  investingCashFlow: FinancialsLineItemSchema.optional(),
  financingCashFlow: FinancialsLineItemSchema.optional(),
  /** Derived: OperatingCashFlow - PaymentsToAcquirePropertyPlantAndEquipment. */
  freeCashFlow: FinancialsLineItemSchema.optional(),
  capitalExpenditures: FinancialsLineItemSchema.optional(),
  // plan-v2 §5.1 — extended XBRL coverage. D&A drives accrual ratio
  // refinement; SBC drives quality-of-earnings overlays.
  depreciationAndAmortization: FinancialsLineItemSchema.optional(),
  stockBasedCompensation: FinancialsLineItemSchema.optional(),
  paymentsOfDividends: FinancialsLineItemSchema.optional(),
  repurchaseOfCommonStock: FinancialsLineItemSchema.optional(),
});
export type CashFlow = z.infer<typeof CashFlowSchema>;

// ============================================================================
// PeriodEntry — 一个会计期间的三表数据 + 元信息
// ============================================================================

export const FinancialsPeriodKindSchema = z.enum(['FY', 'Q', 'TTM']);
export type FinancialsPeriodKind = z.infer<typeof FinancialsPeriodKindSchema>;

export const FinancialsPeriodEntrySchema = z.object({
  /**
   * 人类可读 period 标识。约定：
   * - 'FY2024'                    — 年度（10-K / 20-F）
   * - 'Q3-FY2024'                 — 季度（10-Q）
   * - 'TTM-as-of-Q2-FY2025'       — 滚动 12 个月（connector 派生）
   */
  fiscalPeriod: z.string().min(1),
  kind: FinancialsPeriodKindSchema,
  /**
   * Period 结束日 ISO 字符串 'YYYY-MM-DD'。
   * - FY / Q：财报对应的财年/季度结束日
   * - TTM：构成 TTM 的最新 Q 的结束日
   */
  fiscalYearEnd: z.string(),
  /**
   * Filing 提交日 ISO 字符串 'YYYY-MM-DD'。
   * - FY / Q：SEC 收到对应 10-K/10-Q 的日期
   * - TTM：构成 TTM 的 4 个 Q 中最新一个的 filed 日期
   */
  filed: z.string(),
  /**
   * 报表类型。'derived-TTM' 标注 connector 派生的 TTM entry，便于下游识别。
   * 不限定 enum 防止罕见 form type (15-12B / NT 10-K) 阻塞 schema。
   */
  formType: z.enum(['10-K', '10-Q', '20-F', '40-F', 'derived-TTM']).optional(),
  income: IncomeStatementSchema,
  balance: BalanceSheetSchema,
  cashFlow: CashFlowSchema,
  /**
   * TTM 派生用：列出构成 TTM 的 4 个 Q 的 fiscalPeriod。
   * 例如 ['Q3-FY2024', 'Q4-FY2024', 'Q1-FY2025', 'Q2-FY2025']。
   * 仅 kind='TTM' 时填充。
   */
  derivedFromPeriods: z.array(z.string()).optional(),
});
export type FinancialsPeriodEntry = z.infer<typeof FinancialsPeriodEntrySchema>;

// ============================================================================
// Bundle — 一只股票的完整 financials 输出
// ============================================================================

export const FinancialsBundleSchema = z.object({
  /**
   * 最新在前：[TTM (如有), 最新 Q, 上一 Q, ..., 最近 N 个 FY]。
   * 默认 N=5 (input.years)。TTM 是否生成由 connector 决定（边界 case 时
   * skipped）。
   */
  periods: z.array(FinancialsPeriodEntrySchema).min(0),
  /** ISO 4217 货币代码。US 公司通常 'USD'；外国发行人可能 'EUR' / 'GBP'。 */
  currency: z.string().length(3),
  /** Provenance — SEC EDGAR company-facts JSON URL。EvidencePack 直接引用。 */
  sourceUrl: z.string().url(),
  retrievedAt: z.string().datetime(),
  /**
   * Connector ID emitted on the matching ResearchCitation.provider. Lets
   * downstream consumers (snapshot builder, EvidencePack wrapper) recover
   * the source of truth without parsing sourceUrl. e.g.
   *   'sec-edgar-xbrl' (Phase 1 US)
   *   'eastmoney-financials' (Phase 2 CN)
   */
  provider: z.string().min(1),
  /**
   * Source quality tier (matches the manifest's `defaultQualityTier`).
   *   - 'A' = official regulatory source (SEC EDGAR XBRL)
   *   - 'B' = data aggregator (Eastmoney)
   * EvidencePack reads this to stamp `Fact<FinancialsBundle>.sourceTier`.
   */
  qualityTier: z.enum(['A', 'B', 'C', 'D', 'E']),
  /**
   * 当 connector 因边界 case 跳过 TTM 派生时填充。例：
   * - 'irregular quarter length detected (financial year change?)'
   * - 'mixed restated/original data — manual review needed'
   * - 'insufficient quarters: 2/4'
   * 正常情况 undefined。
   */
  ttmSkippedReason: z.string().optional(),
});
export type FinancialsBundle = z.infer<typeof FinancialsBundleSchema>;

// ============================================================================
// Port input + interface
// ============================================================================

export interface FinancialsInput {
  instrumentId: string;
  /**
   * 取最近 N 个会计年度的数据。默认 5。
   * Connector 实际返回 entries = N FY + 最新已发 Q + 1 TTM (如可派生)。
   */
  years?: number;
  /**
   * 是否派生 TTM。默认 true。
   * 设 false 跳过派生（fundamental-only 路径不需要 TTM）。
   */
  deriveTTM?: boolean;
}

export interface FinancialsPort {
  fetchFinancials(
    input: FinancialsInput,
    ctx?: ConnectorRunContext,
  ): Promise<ResearchResult<FinancialsBundle | null>>;
}
