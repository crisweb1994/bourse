import { z } from 'zod';
import { DecimalStringSchema } from '../contracts/scalars';
import type { ResearchResult } from '../contracts/result';
import type { ConnectorRunContext } from '../connectors/types';
import type { FinancialsInput } from './financials';

/**
 * Financials v2 contract — structured-first earnings actuals.
 *
 * 对应 docs/structured-first-earnings-architecture.md §6（2026-08-01 定稿）。
 *
 * 与 v1（ports/financials.ts）的关键差异：
 * - `kind = FY | Q | TTM` 拆成 `fiscalPeriodType`（Q1..Q4/H1/9M/FY/TTM）
 *   + fact 级 `accumulation`（discrete/YTD/FY/TTM）；
 * - 时点值（instant）不携带 accumulation；
 * - 每个 fact 携带完整 provenance（provider/sourceField/accession/filed/snapshot）；
 * - 修订身份是 fact 级（SEC 同一 period 的 facts 可来自不同 filing）；
 * - `scale` 语义：value = 上游原始数值，实际金额 = value × scale；
 * - bundle 为不可变快照（snapshotId + contentHash 由调用方计算）。
 */

export const FinancialsV2IsoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export type FinancialsV2IsoDate = z.infer<typeof FinancialsV2IsoDateSchema>;

export const FinancialsV2IsoDateTimeSchema = z.string().datetime();
export type FinancialsV2IsoDateTime = z.infer<typeof FinancialsV2IsoDateTimeSchema>;

export const FiscalPeriodTypeSchema = z.enum([
  'Q1',
  'Q2',
  'Q3',
  'Q4',
  'H1',
  '9M',
  'FY',
  'TTM',
]);
export type FiscalPeriodType = z.infer<typeof FiscalPeriodTypeSchema>;

export const FlowAccumulationSchema = z.enum([
  'discrete',
  'YTD',
  'FY',
  'TTM',
]);
export type FlowAccumulation = z.infer<typeof FlowAccumulationSchema>;

export const SourceNatureSchema = z.enum([
  'official_structured',
  'official_document_derived',
  'licensed_structured',
  'aggregated_structured',
]);
export type SourceNature = z.infer<typeof SourceNatureSchema>;

export const FinancialMetricCodeSchema = z.enum([
  'revenue',
  'costOfRevenue',
  'grossProfit',
  'operatingIncome',
  'netIncome',
  'netIncomeAttrib',
  'epsBasic',
  'epsDiluted',
  'operatingCashFlow',
  'capitalExpenditures',
  'freeCashFlow',
  'totalAssets',
  'totalLiabilities',
  'totalEquity',
  'cashAndCashEquivalents',
]);
export type FinancialMetricCode = z.infer<typeof FinancialMetricCodeSchema>;

export const FinancialFactUnitSchema = z.enum([
  'currency',
  'shares',
  'per_share',
  'percent',
  'ratio',
]);
export type FinancialFactUnit = z.infer<typeof FinancialFactUnitSchema>;

export const FinancialAccountingBasisSchema = z.enum([
  'US-GAAP',
  'IFRS',
  'CAS',
  'HKFRS',
  'OTHER',
]);
export type FinancialAccountingBasis = z.infer<typeof FinancialAccountingBasisSchema>;

export const FinancialReportingScopeSchema = z.enum([
  'consolidated',
  'parent',
  'unknown',
]);
export type FinancialReportingScope = z.infer<typeof FinancialReportingScopeSchema>;

export const FinancialQualityTierSchema = z.enum(['A', 'B', 'C', 'D', 'E']);
export type FinancialQualityTier = z.infer<typeof FinancialQualityTierSchema>;

export const FinancialFactSchema = z
  .object({
    id: z.string().min(1),
    metricCode: FinancialMetricCodeSchema,
    // value = 上游原始数值（decimal string），实际金额 = value × scale。
    value: DecimalStringSchema,
    unit: FinancialFactUnitSchema,
    currency: z.string().length(3).optional(),
    // 默认 1（上游已是 base 单位）。connector 负责正确设置 scale。
    scale: z.number().int().positive().default(1),
    periodKind: z.enum(['instant', 'duration']),
    periodStartOn: FinancialsV2IsoDateSchema.optional(),
    periodEndOn: FinancialsV2IsoDateSchema,
    // 仅 duration fact 携带；instant（时点值）不得携带（见 superRefine）。
    accumulation: FlowAccumulationSchema.optional(),
    accountingBasis: FinancialAccountingBasisSchema,
    reportingScope: FinancialReportingScopeSchema,
    derivation: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('reported') }),
      z.object({
        kind: z.literal('computed'),
        formula: z.string().min(1),
        inputFactIds: z.array(z.string().min(1)).min(1),
      }),
    ]),
    provenance: z.object({
      provider: z.string().min(1),
      sourceNature: SourceNatureSchema,
      qualityTier: FinancialQualityTierSchema,
      sourceUrl: z.string().url(),
      sourceField: z.string().min(1),
      accessionNumber: z.string().optional(),
      sourceFiledAt: FinancialsV2IsoDateTimeSchema.optional(),
      sourceRevisionId: z.string().optional(),
      snapshotId: z.string().min(1),
      retrievedAt: FinancialsV2IsoDateTimeSchema,
    }),
  })
  .superRefine((fact, ctx) => {
    if ((fact.unit === 'currency' || fact.unit === 'per_share') && !fact.currency) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['currency'],
        message: 'currency is required for currency and per_share facts',
      });
    }
    if (fact.periodKind === 'duration') {
      if (!fact.periodStartOn) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['periodStartOn'],
          message: 'duration fact must have periodStartOn',
        });
      }
      if (!fact.accumulation) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['accumulation'],
          message: 'duration fact must have accumulation',
        });
      }
    }
    if (fact.periodKind === 'instant' && fact.accumulation !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['accumulation'],
        message: 'instant fact must not carry accumulation',
      });
    }
    if (fact.accumulation === 'FY' && fact.periodKind !== 'duration') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['accumulation'],
        message: 'FY accumulation requires a duration fact',
      });
    }
    if (fact.accumulation === 'TTM' && fact.derivation.kind !== 'computed') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['accumulation'],
        message: 'TTM fact must be computed',
      });
    }
  });
export type FinancialFact = z.infer<typeof FinancialFactSchema>;

export const FinancialRevisionSchema = z.object({
  kind: z.enum(['original', 'amended', 'restated', 'corrected', 'unknown']),
  revisionId: z.string().optional(),
  supersedesRevisionId: z.string().optional(),
  effectiveAt: FinancialsV2IsoDateTimeSchema.optional(),
});
export type FinancialRevision = z.infer<typeof FinancialRevisionSchema>;

export const FinancialPeriodSchema = z
  .object({
    id: z.string().min(1),
    fiscalYear: z.number().int(),
    fiscalPeriodType: FiscalPeriodTypeSchema,
    periodStartOn: FinancialsV2IsoDateSchema.optional(),
    periodEndOn: FinancialsV2IsoDateSchema,
    fiscalCalendarId: z.string().optional(),
    publishedAt: FinancialsV2IsoDateTimeSchema.optional(),
    formType: z.string().optional(),
    reportingScope: FinancialReportingScopeSchema,
    accountingBasis: FinancialAccountingBasisSchema,
    // 汇总字段，不强制整期一致；事实级修订身份以 provenance 三字段为准。
    revision: FinancialRevisionSchema,
    facts: z.array(FinancialFactSchema),
  })
  .superRefine((period, ctx) => {
    const seen = new Map<string, FinancialFact[]>();
    for (const fact of period.facts) {
      const key = [
        fact.metricCode,
        fact.reportingScope,
        fact.accountingBasis,
        fact.accumulation ?? 'none',
        fact.currency ?? '',
      ].join('|');
      const list = seen.get(key) ?? [];
      list.push(fact);
      seen.set(key, list);
    }
    for (const [key, facts] of seen) {
      const reported = facts.filter((fact) => fact.derivation.kind === 'reported');
      if (reported.length < 2) continue;
      const identities = new Set(
        reported.map((fact) =>
          [
            fact.provenance.accessionNumber ?? '',
            fact.provenance.sourceFiledAt ?? '',
            fact.provenance.sourceRevisionId ?? '',
          ].join('|'),
        ),
      );
      if (identities.size < reported.length) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['facts'],
          message: `duplicate reported facts for ${key} without revision distinction`,
        });
      }
    }
  });
export type FinancialPeriod = z.infer<typeof FinancialPeriodSchema>;

export const FinancialsBundleV2Schema = z
  .object({
    schemaVersion: z.literal('financials-v2'),
    instrumentId: z.string().min(1),
    provider: z.string().min(1),
    sourceNature: SourceNatureSchema,
    qualityTier: FinancialQualityTierSchema,
    sourceUrl: z.string().url(),
    retrievedAt: FinancialsV2IsoDateTimeSchema,
    snapshotId: z.string().min(1),
    periods: z.array(FinancialPeriodSchema),
  })
  .superRefine((bundle, ctx) => {
    const periodIds = new Set<string>();
    const factIds = new Set<string>();
    for (const period of bundle.periods) {
      if (periodIds.has(period.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['periods'],
          message: `duplicate period id ${period.id}`,
        });
      }
      periodIds.add(period.id);
      for (const fact of period.facts) {
        if (factIds.has(fact.id)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['periods'],
            message: `duplicate fact id ${fact.id}`,
          });
        }
        factIds.add(fact.id);
        if (fact.provenance.snapshotId !== bundle.snapshotId) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['periods'],
            message: `fact ${fact.id} snapshotId does not match bundle snapshotId`,
          });
        }
        if (period.fiscalPeriodType === 'TTM') {
          if (fact.derivation.kind !== 'computed') {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['periods'],
              message: `TTM period ${period.id} fact ${fact.id} must be computed`,
            });
          } else if (fact.derivation.inputFactIds.length < 4) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['periods'],
              message: `TTM fact ${fact.id} must reference four input periods`,
            });
          }
          if (fact.accumulation !== 'TTM') {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['periods'],
              message: `TTM fact ${fact.id} must have accumulation TTM`,
            });
          }
        }
        if (period.fiscalPeriodType === 'FY' && fact.periodKind === 'duration') {
          if (fact.accumulation !== 'FY') {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['periods'],
              message: `FY period ${period.id} duration fact ${fact.id} must have accumulation FY`,
            });
          }
        }
      }
    }
    for (const period of bundle.periods) {
      for (const fact of period.facts) {
        if (fact.derivation.kind !== 'computed') continue;
        for (const inputId of fact.derivation.inputFactIds) {
          if (!factIds.has(inputId)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['periods'],
              message: `computed fact ${fact.id} references unknown input fact ${inputId}`,
            });
          }
        }
      }
    }
  });
export type FinancialsBundleV2 = z.infer<typeof FinancialsBundleV2Schema>;

/** v2 financials connector 端口（structured-first earnings，未接 routing）。 */
export interface ProviderFinancialsV2Port {
  fetchFinancials(
    input: FinancialsInput,
    ctx?: ConnectorRunContext,
  ): Promise<ResearchResult<FinancialsBundleV2 | null>>;
}
