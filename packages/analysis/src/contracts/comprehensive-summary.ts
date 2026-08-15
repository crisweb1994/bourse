import { z } from 'zod';
import { Citation, Evidence } from './citation';
import { Confidence, OverallSignal, SectionType } from './enums';

export const OverallConclusion = z.object({
  headline: z.string().min(1),
  signal: OverallSignal.nullable(),
  confidence: Confidence,
  rationale: z.array(Evidence),
  counterpoints: z.array(Evidence),
  changeConditions: z.array(z.string()),
  missingSections: z.array(SectionType),
  dataAsOf: z.string().min(1),
  disclaimer: z.string().min(1),
});
export type OverallConclusion = z.infer<typeof OverallConclusion>;

export const ComprehensiveSummary = OverallConclusion;
export type ComprehensiveSummary = OverallConclusion;

export const SummaryCitation = Citation;
