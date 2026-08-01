import { z } from 'zod';
import Decimal from 'decimal.js';
import { DecimalStringSchema } from '@bourse/market-data';

export { DecimalStringSchema };

export const EarningsMetricCodeSchema = z.enum([
  'revenue',
  'costOfRevenue',
  'grossProfit',
  'operatingIncome',
  'netIncome',
  'netIncomeAttrib',
  'epsBasic',
  'epsDiluted',
  'grossMargin',
  'operatingMargin',
  'netMargin',
  'operatingCashFlow',
  'capitalExpenditures',
  'freeCashFlow',
  'totalAssets',
  'totalLiabilities',
  'totalEquity',
  'cashAndCashEquivalents',
]);
export type EarningsMetricCode = z.infer<typeof EarningsMetricCodeSchema>;

export const MetricScalarValueSchema = z.object({
  kind: z.literal('scalar'),
  value: DecimalStringSchema,
});

export const MetricRangeValueSchema = z.object({
  kind: z.literal('range'),
  min: DecimalStringSchema,
  max: DecimalStringSchema,
});

export const MetricValueSchema = z
  .discriminatedUnion('kind', [MetricScalarValueSchema, MetricRangeValueSchema])
  .superRefine((value, ctx) => {
    if (value.kind === 'range' && new Decimal(value.min).gt(value.max)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'range min must be <= max' });
    }
  });
export type MetricValue = z.infer<typeof MetricValueSchema>;

export const EarningsUnitSchema = z.enum([
  'currency',
  'percent',
  'percentage_point',
  'shares',
  'per_share',
  'ratio',
]);
export type EarningsUnit = z.infer<typeof EarningsUnitSchema>;

export const PeriodKindSchema = z.enum(['instant', 'duration']);
export const AccumulationSchema = z.enum(['discrete', 'YTD', 'FY']);
export const ConsolidationScopeSchema = z.enum([
  'consolidated',
  'parent',
  'unknown',
]);

const IsoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const FilingSpanSchema = z.object({
  kind: z.literal('filingSpan'),
  filingId: z.string().min(1),
  derivationId: z.string().min(1),
  contentHash: z.string().min(32),
  quote: z.string().min(1),
  startOffset: z.number().int().nonnegative(),
  endOffset: z.number().int().positive(),
  page: z.number().int().positive().optional(),
  section: z.string().min(1).optional(),
});

export const StructuredSourceSchema = z.object({
  kind: z.literal('structuredSource'),
  provider: z.string().min(1),
  sourceUrl: z.string().url(),
  fieldPath: z.string().min(1),
  asOf: z.string().datetime(),
});

export const MetricProvenanceSchema = z.discriminatedUnion('kind', [
  FilingSpanSchema,
  StructuredSourceSchema,
]);

export const MetricDerivationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('reported') }),
  z.object({
    kind: z.literal('computed'),
    formula: z.string().min(1),
    inputFactIds: z.array(z.string().min(1)).min(1),
  }),
]);

export const MetricCheckStatusSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('passed'), checks: z.array(z.string()) }),
  z.object({
    status: z.literal('rejected'),
    reasons: z.array(z.string().min(1)).min(1),
  }),
]);

export const MetricReconcileStatusSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('pending') }),
  z.object({
    status: z.literal('reconciled'),
    comparedWith: StructuredSourceSchema,
    delta: DecimalStringSchema,
  }),
  z.object({
    status: z.literal('conflicted'),
    comparedWith: StructuredSourceSchema,
    sourceValue: MetricValueSchema,
    structuredValue: MetricValueSchema,
    delta: DecimalStringSchema,
  }),
  z.object({ status: z.literal('not_applicable'), reason: z.string().min(1) }),
]);

export const EarningsComparisonSchema = z.object({
  kind: z.enum(['YOY', 'QOQ', 'GUIDANCE', 'CONSENSUS', 'PREVIOUS_VERSION']),
  label: z.string().min(1),
  referenceValue: MetricValueSchema.optional(),
  absoluteDelta: DecimalStringSchema.optional(),
  percentDelta: DecimalStringSchema.optional(),
  outcome: z.enum(['within', 'above', 'below']).optional(),
  asOf: z.string().datetime().optional(),
  provider: z.string().min(1).optional(),
  sourceUrl: z.string().url().optional(),
  sourceSpan: FilingSpanSchema.optional(),
});
export type EarningsComparison = z.infer<typeof EarningsComparisonSchema>;

export const MetricFactSchema = z
  .object({
    id: z.string().min(1),
    metricCode: EarningsMetricCodeSchema,
    value: MetricValueSchema,
    normalizedValue: MetricValueSchema.optional(),
    unit: EarningsUnitSchema,
    currency: z.string().length(3).optional(),
    scale: z.number().int().positive().default(1),
    periodStartOn: IsoDateSchema.optional(),
    periodEndOn: IsoDateSchema,
    periodKind: PeriodKindSchema,
    accumulation: AccumulationSchema,
    accountingBasis: z.string().min(1),
    consolidationScope: ConsolidationScopeSchema,
    derivation: MetricDerivationSchema,
    provenance: MetricProvenanceSchema,
    claimedYoYPct: DecimalStringSchema.optional(),
    comparisons: z.array(EarningsComparisonSchema).default([]),
    checkStatus: MetricCheckStatusSchema,
    reconcileStatus: MetricReconcileStatusSchema,
  })
  .superRefine((fact, ctx) => {
    if ((fact.unit === 'currency' || fact.unit === 'per_share') && !fact.currency) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['currency'],
        message: 'currency is required for currency and per-share metrics',
      });
    }
    if (
      fact.periodKind === 'duration' &&
      !fact.periodStartOn &&
      fact.provenance.kind === 'filingSpan'
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['periodStartOn'],
        message: 'periodStartOn is required for duration metrics',
      });
    }
  });
export type MetricFact = z.infer<typeof MetricFactSchema>;

/** Strict LLM output before source anchoring and deterministic checks. */
export const MetricFactCandidateSchema = z
  .object({
    metricCode: EarningsMetricCodeSchema,
    value: MetricValueSchema,
    unit: EarningsUnitSchema,
    currency: z.string().length(3).optional(),
    scale: z.number().int().positive().default(1),
    periodStartOn: IsoDateSchema.optional(),
    periodEndOn: IsoDateSchema,
    periodKind: PeriodKindSchema,
    accumulation: AccumulationSchema,
    accountingBasis: z.string().min(1),
    consolidationScope: ConsolidationScopeSchema,
    claimedYoYPct: DecimalStringSchema.optional(),
    sourceQuote: z.string().min(1),
    sourcePage: z.number().int().positive().optional(),
    sourceSection: z.string().min(1).optional(),
  })
  .superRefine((fact, ctx) => {
    if ((fact.unit === 'currency' || fact.unit === 'per_share') && !fact.currency) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['currency'],
        message: 'currency is required for currency and per-share metrics',
      });
    }
    if (fact.periodKind === 'duration' && !fact.periodStartOn) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['periodStartOn'],
        message: 'periodStartOn is required for duration metrics',
      });
    }
  });
export type MetricFactCandidate = z.infer<typeof MetricFactCandidateSchema>;

export const EarningsGuidanceCandidateSchema = z.object({
  metricCode: EarningsMetricCodeSchema,
  value: MetricRangeValueSchema,
  unit: EarningsUnitSchema,
  currency: z.string().length(3).optional(),
  scale: z.number().int().positive().default(1),
  targetPeriodEndOn: IsoDateSchema,
  targetPeriodType: z.literal('FY'),
  accountingBasis: z.string().min(1),
  consolidationScope: ConsolidationScopeSchema,
  sourceQuote: z.string().min(1),
  sourcePage: z.number().int().positive().optional(),
  sourceSection: z.string().min(1).optional(),
}).superRefine((guidance, ctx) => {
  if ((guidance.unit === 'currency' || guidance.unit === 'per_share') && !guidance.currency) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['currency'],
      message: 'currency is required for currency and per-share guidance',
    });
  }
  if (guidance.unit !== 'currency' && guidance.scale !== 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['scale'],
      message: 'non-currency guidance cannot be scaled',
    });
  }
});
export type EarningsGuidanceCandidate = z.infer<typeof EarningsGuidanceCandidateSchema>;

export const EarningsManagementClaimCandidateSchema = z.object({
  text: z.string().min(1),
  sourceQuote: z.string().min(1),
  sourcePage: z.number().int().positive().optional(),
  sourceSection: z.string().min(1).optional(),
});
export type EarningsManagementClaimCandidate = z.infer<typeof EarningsManagementClaimCandidateSchema>;

/**
 * 非 GAAP 补充指标候选（docs/structured-first-earnings-architecture.md §10）。
 * 只进独立 supplemental 集合，不映射 canonical metricCode，不覆盖 GAAP 核心。
 */
export const SupplementalFactCandidateSchema = z
  .object({
    metricLabel: z.string().min(1), // 原始标签，如 "Non-GAAP EPS" / "经调整净利润"
    value: MetricValueSchema,
    unit: EarningsUnitSchema,
    currency: z.string().length(3).optional(),
    targetPeriodEndOn: IsoDateSchema,
    sourceQuote: z.string().min(1),
    sourcePage: z.number().int().positive().optional(),
    sourceSection: z.string().min(1).optional(),
    reconciliationContext: z.string().optional(), // 与 GAAP 的对账说明，原文定位
  })
  .superRefine((candidate, ctx) => {
    if (
      (candidate.unit === 'currency' || candidate.unit === 'per_share') &&
      !candidate.currency
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['currency'],
        message: 'currency is required for currency and per-share supplemental facts',
      });
    }
  });
export type SupplementalFactCandidate = z.infer<typeof SupplementalFactCandidateSchema>;

/**
 * Narrative-only 抽取 schema（structured-first）。
 *
 * 与 `EarningsExtractionSchema` 的关键差异：**不包含 canonical core actual
 * `facts`**——从结构上阻止模型写入营收/归母净利润等主字段（第一道边界）。
 * LLM 的 `eventIdentityHints` 只用于辅助诊断，不能单独创建 numeric card。
 */
export const EarningsNarrativeExtractionSchema = z.object({
  eventIdentityHints: z.object({
    periodEndOn: IsoDateSchema.optional(),
    periodType: z.string().optional(),
  }).optional(),
  guidance: z.array(EarningsGuidanceCandidateSchema).default([]),
  managementClaims: z.array(EarningsManagementClaimCandidateSchema).default([]),
  supplementalNonGaapFacts: z.array(SupplementalFactCandidateSchema).default([]),
});
export type EarningsNarrativeExtraction = z.infer<typeof EarningsNarrativeExtractionSchema>;

export const EarningsExtractionSchema = z.object({
  periodEndOn: IsoDateSchema,
  periodType: z.enum(['Q1', 'Q2', 'Q3', 'H1', 'FY']),
  fiscalYear: z.number().int(),
  fiscalQuarter: z.number().int().min(1).max(4).optional(),
  reportingScope: ConsolidationScopeSchema,
  // Item-level validation belongs to the consistency/persistence stage. A
  // malformed candidate must be omitted, not fail the whole filing envelope.
  facts: z.array(z.unknown()),
  guidance: z.array(z.unknown()).default([]),
  managementClaims: z.array(z.unknown()).default([]),
});
export type EarningsExtraction = z.infer<typeof EarningsExtractionSchema>;

export const EarningsRelationTypeSchema = z.enum([
  'SUPPLEMENTS',
  'CORRECTS',
  'SUPERSEDES',
]);

// ============================================================================
// Card 数据状态（docs/structured-first-earnings-architecture.md §13）
// ============================================================================

export const EarningsNumericStatusSchema = z.enum([
  'ready',
  'pending_structured',
  'partial',
  'ambiguous',
  'unsupported',
]);
export type EarningsNumericStatus = z.infer<typeof EarningsNumericStatusSchema>;

export const EarningsNarrativeStatusSchema = z.enum([
  'ready',
  'unavailable',
  'pending',
  'not_applicable',
]);
export type EarningsNarrativeStatus = z.infer<typeof EarningsNarrativeStatusSchema>;

export const EarningsGuidanceStatusSchema = z.enum([
  'ready',
  'none_reported',
  'unavailable',
]);
export type EarningsGuidanceStatus = z.infer<typeof EarningsGuidanceStatusSchema>;

export const EarningsDataStatusSchema = z.object({
  numeric: EarningsNumericStatusSchema,
  narrative: EarningsNarrativeStatusSchema,
  guidance: EarningsGuidanceStatusSchema,
});
export type EarningsDataStatus = z.infer<typeof EarningsDataStatusSchema>;

export const EarningsFilingDescriptorSchema = z
  .object({
    sourceKind: z.enum(['filing', 'structured_fallback']).default('filing'),
    filingId: z.string().min(1).optional(),
    formType: z.string().min(1),
    title: z.string().optional(),
    sourceUrl: z.string().url(),
    publishedAt: z.string().datetime(),
    provider: z.string().min(1),
    language: z.enum(['zh-CN', 'zh-HK', 'en-HK', 'en-US', 'unknown']).optional(),
    unaudited: z.boolean(),
    relationType: EarningsRelationTypeSchema.optional(),
  })
  .superRefine((filing, ctx) => {
    if (filing.sourceKind === 'filing' && !filing.filingId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['filingId'],
        message: 'filingId is required for filing-backed cards',
      });
    }
  });
export type EarningsFilingDescriptor = z.infer<typeof EarningsFilingDescriptorSchema>;

export const EarningsGenerationStatusSchema = z.enum([
  'QUEUED',
  'RUNNING',
  'COMPLETED',
  'FAILED',
]);

export const EarningsCardPayloadSchema = z.object({
  schemaVersion: z.string().min(1),
  event: z.object({
    instrumentId: z.string().min(1),
    periodEndOn: IsoDateSchema,
    periodType: z.string().min(1),
    fiscalYear: z.number().int(),
    fiscalQuarter: z.number().int().min(1).max(4).optional(),
    reportingScope: ConsolidationScopeSchema,
  }),
  filing: EarningsFilingDescriptorSchema,
  supportingFilings: z.array(EarningsFilingDescriptorSchema).default([]),
  facts: z.array(MetricFactSchema),
  // structured-first 原子切换后必填；旧 LLM 卡片兼容期可缺省。
  dataStatus: EarningsDataStatusSchema.optional(),
  managementClaims: z.array(
    z.object({
      id: z.string().min(1),
      text: z.string().min(1),
      sourceSpan: FilingSpanSchema,
    }),
  ),
  omittedFactCount: z.number().int().nonnegative(),
  statusSummary: z.object({
    total: z.number().int().nonnegative(),
    reconciled: z.number().int().nonnegative(),
    pending: z.number().int().nonnegative(),
    conflicted: z.number().int().nonnegative(),
    structuredOnly: z.number().int().nonnegative(),
  }),
  generatedAt: z.string().datetime(),
});
export type EarningsCardPayload = z.infer<typeof EarningsCardPayloadSchema>;
