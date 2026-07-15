import type { StructuredJson } from '../contracts/analysis-result';
import {
  type ConflictSeverity,
  type CrossDimTolerance,
  DEFAULT_CROSS_DIM_TOLERANCE,
  downgradeConfidence,
  type DowngradeRecord,
  type FactConflict,
  type FactObservation,
  type GroundTruthSource,
  type OverallStatus,
  VALIDATED_FACT_KEYS,
  type ValidatedFactKey,
  type ValidatorReport,
} from '../contracts/cross-dim-validator';
import type { Confidence, SectionType } from '../contracts/enums';
import type { EvidencePackV2 } from '../contracts/evidence-pack-v2';
import type { MarketProfile } from '../markets/types';
import { computeDeviation, extractFact } from './cross-dim-extract';

/**
 * RFC-03 §7: main cross-dim consistency validator.
 *
 * Runs AFTER all 9 dims have produced structuredJson + reportMarkdown in
 * a COMPREHENSIVE workflow, BEFORE generateComprehensiveSummary. Compares
 * each dim's view of 5 facts (price / marketCap / currency / pe / dataAsOf)
 * against an authoritative ground truth and emits a `ValidatorReport`.
 *
 * MUTATION WARNING: when a conflict triggers DOWNGRADE (or FAIL on a fact
 * the dim actually surfaced), this function MUTATES
 * `section.structuredJson.conclusion.confidence` in place — the audit trail
 * is preserved in the returned `downgradedDimensions` record. Caller must
 * NOT assume the input sections array is read-only.
 *
 * Ground truth ladder:
 *   1. EvidencePack v2 fact (highest authority) — available for CN only.
 *   2. Market profile lock (currency) — CN→CNY, HK→HKD, etc.
 *   3. Dim-majority — 3+ dims within tight tolerance form a consensus.
 *   4. No ground truth → fact is skipped (insufficient evidence).
 */

export interface SectionForValidation {
  type: SectionType;
  reportMarkdown: string;
  structuredJson: StructuredJson;
}

export interface ValidateCrossDimOptions {
  /** Stage 0 evidence pack (CN COMPREHENSIVE only); ground truth source #1. */
  evidencePack?: EvidencePackV2;
  /** Required for currency lock + per-market tolerance override. */
  marketProfile: MarketProfile;
  /** Override the market's default tolerance (or DEFAULT_CROSS_DIM_TOLERANCE
   *  when the market doesn't define one). Mostly for tests. */
  toleranceOverride?: CrossDimTolerance;
}

/** Max allowed spread between any two dims' dataAsOf values, in days. */
const DATA_AS_OF_MAX_SPREAD_DAYS = 90;

/** Minimum dim observations required to derive a dim-majority ground truth. */
const DIM_MAJORITY_MIN_OBSERVATIONS = 3;

/** Tightness band (%) within which numeric dim values cluster to form
 *  a majority. Independent of warning/downgrade/fail tolerances above —
 *  this is "are dims agreeing with each other", not "is dim wrong vs truth". */
const DIM_MAJORITY_CLUSTER_BAND_PCT = 1.0;

/** Minimum string-value occurrences to claim dim-majority on a non-numeric
 *  fact (currency / dataAsOf). Half of observations rounded up. */
function stringMajorityThreshold(n: number): number {
  return Math.ceil(n / 2);
}

export function validateCrossDim(
  sections: SectionForValidation[],
  options: ValidateCrossDimOptions,
): ValidatorReport {
  const startedAt = Date.now();
  const tolerance =
    options.toleranceOverride ??
    options.marketProfile.crossDimTolerance ??
    DEFAULT_CROSS_DIM_TOLERANCE;

  const conflicts: FactConflict[] = [];

  // Pass 1: detect conflicts per fact key.
  for (const factKey of VALIDATED_FACT_KEYS) {
    const observations = collectObservations(sections, factKey);
    if (observations.length === 0) continue;

    const groundTruth = resolveGroundTruth(
      factKey,
      observations,
      options.evidencePack,
      options.marketProfile,
    );
    if (groundTruth === null) continue;

    if (factKey === 'currency') {
      conflicts.push(
        ...detectCurrencyConflicts(observations, groundTruth),
      );
    } else if (factKey === 'dataAsOf') {
      const dateConflict = detectDataAsOfConflict(
        observations,
        groundTruth,
      );
      if (dateConflict) conflicts.push(dateConflict);
    } else {
      // Numeric: price / marketCap / pe
      conflicts.push(
        ...detectNumericConflicts(
          factKey,
          observations,
          groundTruth,
          tolerance[factKey],
        ),
      );
    }
  }

  // Pass 2: derive per-dim downgrades from DOWNGRADE/FAIL conflicts and
  // mutate section confidence in place. A dim flagged on multiple facts
  // still only downgrades once (HIGH→MEDIUM); the reason string aggregates.
  const dimsNeedingDowngrade = collectDimsToDowngrade(conflicts);
  const downgrades: DowngradeRecord[] = [];

  for (const [type, reasons] of dimsNeedingDowngrade.entries()) {
    const section = sections.find((s) => s.type === type);
    if (!section) continue;
    const original = section.structuredJson.conclusion.confidence;
    const next = downgradeConfidence(original);
    if (next === original) {
      // Already at LOW — record the attempted downgrade for transparency
      // but keep originalConfidence === downgradedTo. Audit trail still
      // shows the validator tried.
      downgrades.push({
        type,
        originalConfidence: original,
        downgradedTo: next,
        reason: aggregateReasons(reasons),
      });
      continue;
    }
    // Apply mutation.
    section.structuredJson.conclusion.confidence = next;
    downgrades.push({
      type,
      originalConfidence: original,
      downgradedTo: next,
      reason: aggregateReasons(reasons),
    });
  }

  const overallStatus = decideOverallStatus(conflicts);
  const severityCounts = countSeverities(conflicts);

  return {
    overallStatus,
    conflicts,
    downgradedDimensions: downgrades,
    summary: {
      totalConflicts: conflicts.length,
      severityCounts,
      durationMs: Date.now() - startedAt,
    },
  };
}

// ===== Internal helpers =====

function collectObservations(
  sections: SectionForValidation[],
  factKey: ValidatedFactKey,
): FactObservation[] {
  const out: FactObservation[] = [];
  for (const s of sections) {
    const obs = extractFact(s, factKey);
    if (obs !== null) out.push(obs);
  }
  return out;
}

function resolveGroundTruth(
  factKey: ValidatedFactKey,
  observations: FactObservation[],
  evidencePack: EvidencePackV2 | undefined,
  marketProfile: MarketProfile,
): { value: unknown; source: GroundTruthSource } | null {
  // Currency is locked to market profile — always wins over EvidencePack
  // (a v2 pack reporting USD for a CN-listed symbol is itself a bug).
  if (factKey === 'currency') {
    return {
      value: marketProfile.displayCurrency.toUpperCase(),
      source: 'market-profile',
    };
  }

  // EvidencePack v2 has authoritative numeric facts when available.
  if (evidencePack) {
    if (factKey === 'price' && evidencePack.facts.quote) {
      return { value: evidencePack.facts.quote.value, source: 'evidence-pack' };
    }
    if (factKey === 'marketCap' && evidencePack.facts.marketCap) {
      return {
        value: evidencePack.facts.marketCap.value,
        source: 'evidence-pack',
      };
    }
    if (factKey === 'pe' && evidencePack.facts.pe) {
      return { value: evidencePack.facts.pe.value, source: 'evidence-pack' };
    }
    if (factKey === 'dataAsOf') {
      // Use the capturedAt YYYY-MM-DD as truth (pack was built today/recent).
      return {
        value: evidencePack.capturedAt.slice(0, 10),
        source: 'evidence-pack',
      };
    }
  }

  // Dim-majority fallback.
  if (factKey === 'price' || factKey === 'marketCap' || factKey === 'pe') {
    return findNumericMajority(observations);
  }
  if (factKey === 'dataAsOf') {
    return findStringMajority(observations);
  }

  return null;
}

function findNumericMajority(
  observations: FactObservation[],
): { value: number; source: GroundTruthSource } | null {
  const values: number[] = [];
  for (const o of observations) {
    if (typeof o.value === 'number' && Number.isFinite(o.value)) {
      values.push(o.value);
    }
  }
  if (values.length < DIM_MAJORITY_MIN_OBSERVATIONS) return null;

  const sorted = [...values].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];

  // Count values within the cluster band of median.
  const inBand = values.filter((v) => {
    if (median === 0) return v === 0;
    return Math.abs((v - median) / median) * 100 < DIM_MAJORITY_CLUSTER_BAND_PCT;
  });
  if (inBand.length < DIM_MAJORITY_MIN_OBSERVATIONS) return null;

  return { value: median, source: 'dim-majority' };
}

function findStringMajority(
  observations: FactObservation[],
): { value: string; source: GroundTruthSource } | null {
  const counts = new Map<string, number>();
  for (const o of observations) {
    if (typeof o.value !== 'string') continue;
    counts.set(o.value, (counts.get(o.value) ?? 0) + 1);
  }
  if (counts.size === 0) return null;

  let bestValue: string | null = null;
  let bestCount = 0;
  for (const [v, n] of counts.entries()) {
    if (n > bestCount) {
      bestValue = v;
      bestCount = n;
    }
  }
  if (bestValue === null) return null;

  if (bestCount < stringMajorityThreshold(observations.length)) return null;
  return { value: bestValue, source: 'dim-majority' };
}

function detectCurrencyConflicts(
  observations: FactObservation[],
  groundTruth: { value: unknown; source: GroundTruthSource },
): FactConflict[] {
  const out: FactConflict[] = [];
  for (const obs of observations) {
    if (typeof obs.value === 'string' && obs.value !== groundTruth.value) {
      out.push({
        factKey: 'currency',
        severity: 'FAIL',
        groundTruth,
        observations: [obs],
        message: `${obs.sectionType} reported currency=${obs.value} but market profile locks it to ${groundTruth.value}`,
      });
    }
  }
  return out;
}

function detectDataAsOfConflict(
  observations: FactObservation[],
  groundTruth: { value: unknown; source: GroundTruthSource },
): FactConflict | null {
  if (typeof groundTruth.value !== 'string') return null;

  const truthMs = Date.parse(groundTruth.value);
  if (Number.isNaN(truthMs)) return null;

  let maxSpreadDays = 0;
  const offenders: FactObservation[] = [];
  for (const obs of observations) {
    if (typeof obs.value !== 'string') continue;
    const t = Date.parse(obs.value);
    if (Number.isNaN(t)) continue;
    const spreadDays = Math.abs(t - truthMs) / 86_400_000;
    if (spreadDays > DATA_AS_OF_MAX_SPREAD_DAYS) {
      offenders.push(obs);
      maxSpreadDays = Math.max(maxSpreadDays, spreadDays);
    }
  }
  if (offenders.length === 0) return null;

  return {
    factKey: 'dataAsOf',
    severity: 'FAIL',
    groundTruth,
    observations: offenders,
    maxDeviation: maxSpreadDays,
    message: `${offenders.length} dim(s) carry dataAsOf > ${DATA_AS_OF_MAX_SPREAD_DAYS} days from ground truth (${groundTruth.value}); max spread ${maxSpreadDays.toFixed(0)} days`,
  };
}

function detectNumericConflicts(
  factKey: 'price' | 'marketCap' | 'pe',
  observations: FactObservation[],
  groundTruth: { value: unknown; source: GroundTruthSource },
  thresholds: { warning: number; downgrade: number; fail: number },
): FactConflict[] {
  const out: FactConflict[] = [];
  for (const obs of observations) {
    const dev = computeDeviation(obs.value, groundTruth.value);
    if (dev === null) continue;
    const severity = classifyNumeric(dev, thresholds);
    if (severity === null) continue;
    out.push({
      factKey,
      severity,
      groundTruth,
      observations: [obs],
      maxDeviation: dev,
      message: `${obs.sectionType} reported ${factKey}=${formatNumber(obs.value)} but ground truth (${groundTruth.source}) is ${formatNumber(groundTruth.value)} — ${dev.toFixed(2)}% deviation`,
    });
  }
  return out;
}

function classifyNumeric(
  deviation: number,
  thresholds: { warning: number; downgrade: number; fail: number },
): ConflictSeverity | null {
  if (deviation > thresholds.fail) return 'FAIL';
  if (deviation > thresholds.downgrade) return 'DOWNGRADE';
  if (deviation > thresholds.warning) return 'WARNING';
  return null;
}

function collectDimsToDowngrade(
  conflicts: FactConflict[],
): Map<SectionType, string[]> {
  // Only DOWNGRADE / FAIL conflicts demand a confidence adjustment. WARNING
  // is informational (written to validator report; doesn't touch dim output).
  const out = new Map<SectionType, string[]>();
  for (const c of conflicts) {
    if (c.severity !== 'DOWNGRADE' && c.severity !== 'FAIL') continue;
    for (const obs of c.observations) {
      const list = out.get(obs.sectionType) ?? [];
      list.push(`[${c.factKey}/${c.severity}] ${c.message}`);
      out.set(obs.sectionType, list);
    }
  }
  return out;
}

function decideOverallStatus(conflicts: FactConflict[]): OverallStatus {
  if (conflicts.some((c) => c.severity === 'FAIL')) return 'FAIL';
  if (conflicts.some((c) => c.severity === 'DOWNGRADE')) return 'DOWNGRADE';
  if (conflicts.some((c) => c.severity === 'WARNING')) return 'WARNING';
  return 'OK';
}

function countSeverities(
  conflicts: FactConflict[],
): { WARNING: number; DOWNGRADE: number; FAIL: number } {
  const counts = { WARNING: 0, DOWNGRADE: 0, FAIL: 0 };
  for (const c of conflicts) counts[c.severity] += 1;
  return counts;
}

function aggregateReasons(reasons: string[]): string {
  // Cap aggregate length so downstream JSON serialization stays reasonable.
  const joined = reasons.join(' | ');
  if (joined.length <= 800) return joined;
  return joined.slice(0, 797) + '...';
}

function formatNumber(v: unknown): string {
  if (typeof v !== 'number') return String(v);
  // Trim noisy precision for log/message use; full value already in observation.
  return Number.isInteger(v) ? String(v) : v.toFixed(2);
}

// Re-export Confidence type so callers reading the mutated structuredJson
// don't need a separate import.
export type { Confidence };
