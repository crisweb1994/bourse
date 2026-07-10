import { z } from 'zod';
import { Evidence } from './citation';
import { Confidence, SectionType, Signal } from './enums';

/**
 * Per-dimension signal block surfaced inside ComprehensiveSummary.
 * Mirrors shared-types ComprehensiveSummary.sectionSignals[].
 */
export const SectionSignal = z.object({
  type: SectionType,
  signal: Signal,
  confidence: Confidence,
  oneLiner: z.string().min(1),
});
export type SectionSignal = z.infer<typeof SectionSignal>;

/**
 * Output of the comprehensive workflow's summary stage. Mirrors
 * shared-types ComprehensiveSummary so downstream consumers (apps/api,
 * apps/web) keep wire-format compatibility.
 */
export const ComprehensiveSummary = z.object({
  overallSignal: Signal,
  overallConfidence: Confidence,
  oneLiner: z.string().min(1),
  bullCase: z.array(z.string()),
  bearCase: z.array(z.string()),
  biggestRisk: z.string(),
  valuationConclusion: z.string(),
  suitableInvestorType: z.string(),
  watchlistWorthy: z.boolean(),
  sectionSignals: z.array(SectionSignal),
  evidence: z.array(Evidence),
  dataAsOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  disclaimer: z.string().min(1),
});
export type ComprehensiveSummary = z.infer<typeof ComprehensiveSummary>;
