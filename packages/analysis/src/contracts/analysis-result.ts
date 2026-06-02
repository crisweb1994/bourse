import { z } from 'zod';
import {
  InvestmentHorizon as SharedInvestmentHorizon,
  RiskTolerance as SharedRiskTolerance,
} from '@bourse/shared-types';
import { Citation, Evidence } from './citation';
import { ComprehensiveSummary } from './comprehensive-summary';
import {
  AnalysisType,
  Confidence,
  Recommendation,
  RunStatus,
  Signal,
} from './enums';
import { Trace } from './trace';

// Bumped only when structuredJson shape changes in a non-additive way.
export const SCHEMA_VERSION = 'agent-result-v1' as const;
export const SchemaVersion = z.literal(SCHEMA_VERSION);
export type SchemaVersion = z.infer<typeof SchemaVersion>;

// ===== Baseline structuredJson (mirrors shared-types BaseSectionData) =====

export const SectionConclusion = z.object({
  signal: Signal,
  confidence: Confidence,
  oneLiner: z.string().min(1),
  evidence: z.array(Evidence),
});
export type SectionConclusion = z.infer<typeof SectionConclusion>;

export const DataAvailability = z.object({
  missingFields: z.array(z.string()),
  reason: z.string(),
});
export type DataAvailability = z.infer<typeof DataAvailability>;

// ===== Optional enhancements (decoupled from `signal`) =====

export const PriceTarget = z.object({
  low: z.number().optional(),
  base: z.number(),
  high: z.number().optional(),
  currency: z.string().min(1),
  horizonDays: z.number().int().positive(),
});
export type PriceTarget = z.infer<typeof PriceTarget>;

// Output-side suitability hint. NOT a personalized recommendation —
// see disclaimer + MVP doc §9.1.
export const Suitability = z.object({
  riskTolerance: z.array(z.nativeEnum(SharedRiskTolerance)).optional(),
  investmentHorizon: z.array(z.nativeEnum(SharedInvestmentHorizon)).optional(),
  notes: z.string().optional(),
});
export type Suitability = z.infer<typeof Suitability>;

// ===== Combined structuredJson =====

export const StructuredJson = z.object({
  // Baseline (required)
  schemaVersion: SchemaVersion,
  conclusion: SectionConclusion,
  evidence: z.array(Evidence),
  dataAvailability: DataAvailability,
  dataAsOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  disclaimer: z.string().min(1),
  // Optional enhancements
  recommendation: Recommendation.optional(),
  priceTarget: PriceTarget.optional(),
  thesis: z.string().optional(),
  keyRisks: z.array(z.string()).optional(),
  dimensionScores: z.record(AnalysisType, z.number().min(0).max(100)).optional(),
  suitability: Suitability.optional(),
  // RFC-02 §13: list of EvidencePack v2 fact keys this section explicitly
  // referenced. Optional + backward-compat — legacy runs without v2 omit it.
  // Helps the cross-dim validator (Phase 2) trace which dims drew on which
  // shared facts, and powers the dashboard's "did the LLM actually use the
  // pack?" view.
  factReferences: z.array(z.string()).optional(),
});
export type StructuredJson = z.infer<typeof StructuredJson>;

// ===== Top-level AnalysisResult =====

/**
 * Union of per-dimension StructuredJson and workflow-level
 * ComprehensiveSummary. Discriminate by checking for `schemaVersion`
 * (StructuredJson only) or `overallSignal` (ComprehensiveSummary only).
 */
export const AnyStructuredJson = z.union([StructuredJson, ComprehensiveSummary]);
export type AnyStructuredJson = z.infer<typeof AnyStructuredJson>;

/** Type guard helper. */
export function isComprehensiveSummary(
  x: AnyStructuredJson,
): x is z.infer<typeof ComprehensiveSummary> {
  return 'overallSignal' in x;
}

export const AnalysisResult = z.object({
  reportMarkdown: z.string(),
  /**
   * Required on COMPLETED / PARTIAL_FAILED. Nullable for FAILED /
   * CANCELLED / BUDGET_EXHAUSTED — the run terminated before structured
   * output could be generated.
   */
  structuredJson: AnyStructuredJson.nullable(),
  citations: z.array(Citation),
  status: RunStatus,
  signal: Signal,
  confidence: Confidence,
  trace: Trace,
  warnings: z.array(z.string()),
  partialDimensions: z.array(AnalysisType).optional(),
});
export type AnalysisResult = z.infer<typeof AnalysisResult>;
