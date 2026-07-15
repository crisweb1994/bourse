import { z } from 'zod';
import { Confidence, SectionType } from './enums';

/**
 * RFC-03 §5: Cross-dimensional validator contracts.
 *
 * The validator runs AFTER all 9 dims complete in a COMPREHENSIVE run and
 * BEFORE generateComprehensiveSummary. It compares fact references across
 * dims (PE / marketCap / currency / dataAsOf / price) against an authoritative
 * ground truth — EvidencePack v2 when available, falls back to dim-majority
 * (3+ dims agreeing) when not. Mismatches are classified into 3 severities
 * and propagated as SSE events + dim-output mutations.
 */

// ===== Severity =====

/**
 * Conflict severity. Lower → upper:
 *   - WARNING:   visible drift but explainable (<1%, different timestamps).
 *                Written to warnings[], no behavior change.
 *   - DOWNGRADE: meaningful drift (1-5%). The affected dim's
 *                conclusion.confidence drops one notch (HIGH → MEDIUM,
 *                MEDIUM → LOW). originalConfidence preserved in warnings
 *                for audit trail.
 *   - FAIL:      severe drift (>5%) or currency / dataAsOf mismatch.
 *                Run halts with PARTIAL_FAILED; summary is skipped but
 *                completed dim outputs survive so the user can still
 *                see per-section content.
 */
export const ConflictSeverity = z.enum(['WARNING', 'DOWNGRADE', 'FAIL']);
export type ConflictSeverity = z.infer<typeof ConflictSeverity>;

/**
 * Top-level run status after the validator. Drives downstream control flow:
 *   - OK / WARNING: continue to summary as usual.
 *   - DOWNGRADE:    continue to summary, but with confidence downgrades
 *                   applied to affected dims.
 *   - FAIL:         skip summary, emit error event, mark run PARTIAL_FAILED.
 */
export const OverallStatus = z.enum(['OK', 'WARNING', 'DOWNGRADE', 'FAIL']);
export type OverallStatus = z.infer<typeof OverallStatus>;

// ===== Ground truth source =====

/**
 * How the validator decided what the "right answer" was.
 *   - evidence-pack: an EvidencePackV2 fact was present and within
 *     freshness. Highest authority.
 *   - dim-majority: no pack value; 3+ dims agreed on a value (within
 *     their own tight tolerance). Medium authority.
 *   - market-profile: market-level constant (e.g. currency for CN
 *     should be CNY no matter what dims claim). Locked authority.
 */
export const GroundTruthSource = z.enum([
  'evidence-pack',
  'dim-majority',
  'market-profile',
]);
export type GroundTruthSource = z.infer<typeof GroundTruthSource>;

// ===== Observation =====

/**
 * One dim's value for a given fact, plus how we extracted it.
 * extractedFrom values are stable strings useful for telemetry queries:
 *   - 'structuredJson.priceTarget.base'
 *   - 'structuredJson.dataAsOf'
 *   - 'structuredJson.priceTarget.currency'
 *   - 'reportMarkdown:regex:pe'
 *   - 'reportMarkdown:regex:marketCap'
 *   - etc.
 */
export const FactObservation = z.object({
  sectionType: SectionType,
  value: z.unknown(),
  extractedFrom: z.string().min(1),
});
export type FactObservation = z.infer<typeof FactObservation>;

// ===== Conflict =====

export const FactConflict = z.object({
  factKey: z.string().min(1),
  severity: ConflictSeverity,
  groundTruth: z
    .object({
      value: z.unknown(),
      source: GroundTruthSource,
    })
    .optional(),
  observations: z.array(FactObservation),
  /**
   * Max % deviation observed (numeric facts only). Absent for
   * currency / dataAsOf where the comparison is exact-match.
   */
  maxDeviation: z.number().nonnegative().optional(),
  message: z.string().min(1),
});
export type FactConflict = z.infer<typeof FactConflict>;

// ===== Downgrade record =====

/**
 * Records a confidence downgrade applied to a dim's output. The validator
 * mutates the section's structuredJson in-place AND emits this record so
 * downstream (SSE consumers, telemetry, dashboards) can see the audit trail
 * without parsing warnings[] strings.
 */
export const DowngradeRecord = z.object({
  type: SectionType,
  originalConfidence: Confidence,
  downgradedTo: Confidence,
  reason: z.string().min(1),
});
export type DowngradeRecord = z.infer<typeof DowngradeRecord>;

// ===== Per-severity counts =====

const SeverityCounts = z.object({
  WARNING: z.number().int().nonnegative(),
  DOWNGRADE: z.number().int().nonnegative(),
  FAIL: z.number().int().nonnegative(),
});

// ===== Report =====

export const ValidatorReport = z.object({
  overallStatus: OverallStatus,
  conflicts: z.array(FactConflict),
  downgradedDimensions: z.array(DowngradeRecord),
  summary: z.object({
    totalConflicts: z.number().int().nonnegative(),
    severityCounts: SeverityCounts,
    durationMs: z.number().nonnegative(),
  }),
});
export type ValidatorReport = z.infer<typeof ValidatorReport>;

// ===== Tolerance config =====

/**
 * Per-fact deviation thresholds in PERCENT (0.5 means 0.5%, not 50%).
 * thresholds[fact] = { warning, downgrade, fail } — must satisfy
 * warning ≤ downgrade ≤ fail or the validator throws at construction.
 */
export const ToleranceTriple = z.object({
  warning: z.number().nonnegative(),
  downgrade: z.number().nonnegative(),
  fail: z.number().nonnegative(),
});
export type ToleranceTriple = z.infer<typeof ToleranceTriple>;

export const CrossDimTolerance = z.object({
  /** Stock price / quote */
  price: ToleranceTriple,
  /** Market capitalization */
  marketCap: ToleranceTriple,
  /** Price-to-earnings ratio (looser default — LLM cites trailing vs forward) */
  pe: ToleranceTriple,
});
export type CrossDimTolerance = z.infer<typeof CrossDimTolerance>;

/**
 * RFC-03 §7 default thresholds. CN-friendly. Override per market in
 * markets/<code>/profile.ts crossDimTolerance.
 */
export const DEFAULT_CROSS_DIM_TOLERANCE: CrossDimTolerance = {
  price: { warning: 0.5, downgrade: 1.0, fail: 5.0 },
  marketCap: { warning: 1.0, downgrade: 3.0, fail: 5.0 },
  pe: { warning: 1.0, downgrade: 5.0, fail: 15.0 },
};

/**
 * The set of fact keys this validator checks. Kept as a runtime-iterable
 * constant so adding a new check (e.g. EV/EBITDA) only requires one line
 * here + a new extractor + (optional) tolerance entry.
 */
export const VALIDATED_FACT_KEYS = [
  'price',
  'marketCap',
  'currency',
  'pe',
  'dataAsOf',
] as const;
export type ValidatedFactKey = (typeof VALIDATED_FACT_KEYS)[number];

/**
 * The validator's confidence-downgrade ladder. HIGH → MEDIUM → LOW; LOW
 * stays LOW (already at the floor). Pure mapping, no side effects.
 */
export function downgradeConfidence(current: Confidence): Confidence {
  if (current === 'HIGH') return 'MEDIUM';
  if (current === 'MEDIUM') return 'LOW';
  return 'LOW';
}
