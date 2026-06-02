import { z } from 'zod';
import { AnalysisType } from './enums';

// Per-run cost limits. Hitting any limit triggers BUDGET_EXHAUSTED with
// partial result; see MVP doc §四 cost guardrail.
export const Budget = z.object({
  maxCostUsd: z.number().positive().optional(),
  maxTokens: z.number().int().positive().optional(),
  maxToolCalls: z.number().int().positive().optional(),
});
export type Budget = z.infer<typeof Budget>;

// Walking-skeleton scope (Day 2): symbol/market/type/locale required;
// competitors/budget present as optional placeholders so downstream
// signatures don't churn when V1 features land.
export const AnalysisRequest = z.object({
  symbol: z.string().min(1),
  market: z.string().min(1),
  type: AnalysisType,
  locale: z.string().min(2).default('zh-CN'),
  competitors: z.array(z.string().min(1)).optional(),
  budget: Budget.optional(),
});
export type AnalysisRequest = z.infer<typeof AnalysisRequest>;
