import { z } from 'zod';

// ============================================================================
// Computed financial ratios
// ============================================================================

export const PeriodTrendSchema = z.object({
  period: z.string(),
  fiscalYearEnd: z.string(),
  revenue: z.number().nullable(),
  netIncome: z.number().nullable(),
  grossMargin: z.number().nullable(),
  netMargin: z.number().nullable(),
  operatingCashFlow: z.number().nullable(),
});
export type PeriodTrend = z.infer<typeof PeriodTrendSchema>;

export const ComputedFinancialRatiosSchema = z.object({
  // 估值
  pe: z.number().nullable(),
  pb: z.number().nullable(),
  ps: z.number().nullable(),
  fcfYield: z.number().nullable(),
  evToEbitda: z.number().nullable(),

  // 盈利能力
  grossMargin: z.number().nullable(),
  operatingMargin: z.number().nullable(),
  netMargin: z.number().nullable(),
  roe: z.number().nullable(),
  roic: z.number().nullable(),
  cashConversionRatio: z.number().nullable(),
  accrualRatio: z.number().nullable(),

  // 杠杆
  debtToEquity: z.number().nullable(),
  currentRatio: z.number().nullable(),
  quickRatio: z.number().nullable(),
  interestCoverage: z.number().nullable(),

  // 增长
  revenueGrowthYoY: z.number().nullable(),
  earningsGrowthYoY: z.number().nullable(),
  revenueCagr3y: z.number().nullable(),
  fcfCagr3y: z.number().nullable(),

  // 每期序列
  periodTrends: z.array(PeriodTrendSchema),

  // Provenance
  baseCurrency: z.enum(['USD', 'CNY', 'HKD']),
  computedAt: z.string().datetime(),
});
export type ComputedFinancialRatios = z.infer<typeof ComputedFinancialRatiosSchema>;

// ============================================================================
// Red flags
// ============================================================================

export const RedFlagSeveritySchema = z.enum(['high', 'medium', 'low']);
export type RedFlagSeverity = z.infer<typeof RedFlagSeveritySchema>;

export const RedFlagCategorySchema = z.enum([
  'accounting',
  'cash_flow',
  'valuation',
  'governance',
]);
export type RedFlagCategory = z.infer<typeof RedFlagCategorySchema>;

export const RedFlagSchema = z.object({
  rule: z.string(),
  severity: RedFlagSeveritySchema,
  category: RedFlagCategorySchema,
  title: z.string(),
  description: z.string(),
  evidence: z.record(z.string(), z.number()),
});
export type RedFlag = z.infer<typeof RedFlagSchema>;

// ============================================================================
// Compute warnings (surfaced via dataAvailability)
// ============================================================================

export const ComputeWarningCodeSchema = z.enum([
  'missing_data',
  'division_by_zero',
  'unknown_unit',
  'insufficient_history',
  'negative_denominator',
]);
export type ComputeWarningCode = z.infer<typeof ComputeWarningCodeSchema>;

export interface ComputeWarning {
  code: ComputeWarningCode;
  metric: string;
  detail: string;
}
