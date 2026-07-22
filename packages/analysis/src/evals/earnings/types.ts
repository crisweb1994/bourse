import { z } from 'zod';
import {
  AccumulationSchema,
  ConsolidationScopeSchema,
  EarningsMetricCodeSchema,
  MetricValueSchema,
} from '../../contracts/earnings';

export const EarningsEvalGoldFactSchema = z.object({
  metricCode: EarningsMetricCodeSchema,
  normalizedValue: MetricValueSchema,
  unit: z.string(),
  currency: z.string().optional(),
  periodStartOn: z.string().optional(),
  periodEndOn: z.string(),
  accumulation: AccumulationSchema,
  accountingBasis: z.string(),
  consolidationScope: ConsolidationScopeSchema,
  sourceQuote: z.string().min(1),
  sourcePage: z.number().int().positive().optional(),
  eligible: z.boolean().default(true),
});

export const EarningsEvalFixtureSchema = z.object({
  meta: z.object({
    id: z.string(),
    market: z.enum(['US', 'CN']),
    split: z.enum(['development', 'blind']),
    formType: z.string(),
    description: z.string().optional(),
  }),
  derivation: z.object({
    id: z.string(),
    filingId: z.string(),
    contentHash: z.string(),
    text: z.string(),
    pages: z
      .array(
        z.object({
          page: z.number().int().positive(),
          startOffset: z.number().int().nonnegative(),
          endOffset: z.number().int().positive(),
        }),
      )
      .optional(),
  }),
  event: z.object({
    periodEndOn: z.string(),
    periodType: z.enum(['Q1', 'Q2', 'Q3', 'H1', 'FY']).optional(),
    reportingScope: ConsolidationScopeSchema,
  }),
  candidates: z.array(z.unknown()),
  goldFacts: z.array(EarningsEvalGoldFactSchema),
});

export type EarningsEvalFixture = z.infer<typeof EarningsEvalFixtureSchema>;

export interface EarningsEvalMetrics {
  documents: number;
  eligibleFacts: number;
  visibleFacts: number;
  correctVisibleFacts: number;
  falseAcceptedFacts: number;
  coverage: number;
  visiblePrecision: number;
  falseAcceptanceRate: number;
  falseAcceptanceUpper95: number;
}
