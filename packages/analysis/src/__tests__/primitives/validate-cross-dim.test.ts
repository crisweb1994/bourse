import { describe, expect, it } from 'vitest';
import type { StructuredJson } from '../../contracts/analysis-result';
import { DEFAULT_CROSS_DIM_TOLERANCE } from '../../contracts/cross-dim-validator';
import type { Confidence, SectionType } from '../../contracts/enums';
import type { EvidencePackV2 } from '../../contracts/evidence-pack-v2';
import { CN } from '../../markets/cn';
import {
  type SectionForValidation,
  validateCrossDim,
} from '../../primitives/validate-cross-dim';

const ISO = '2026-05-13T08:00:00.000Z';
const TODAY = '2026-05-13';

function section(
  type: SectionType,
  overrides: Partial<{
    confidence: Confidence;
    pe: number;
    marketCapYi: number;
    price: number;
    currency: string;
    dataAsOf: string;
  }> = {},
): SectionForValidation {
  const md: string[] = [];
  if (overrides.pe !== undefined) md.push(`PE: ${overrides.pe}`);
  if (overrides.marketCapYi !== undefined) {
    md.push(`总市值 ${overrides.marketCapYi} 亿`);
  }
  if (overrides.price !== undefined) {
    md.push(`当前价 ${overrides.price}`);
  }
  const structuredJson: StructuredJson = {
    schemaVersion: 'agent-result-v1',
    conclusion: {
      signal: 'NEUTRAL',
      confidence: overrides.confidence ?? 'MEDIUM',
      oneLiner: 'baseline',
      evidence: [],
    },
    evidence: [],
    dataAvailability: { missingFields: [], reason: 'ok' },
    dataAsOf: overrides.dataAsOf ?? TODAY,
    disclaimer: 'd',
    ...(overrides.price !== undefined || overrides.currency
      ? {
          priceTarget: {
            base: overrides.price ?? 100,
            currency: overrides.currency ?? 'CNY',
            horizonDays: 90,
          },
        }
      : {}),
  };
  return { type, reportMarkdown: md.join('\n'), structuredJson };
}

function fact<T>(value: T, tier: 'A' | 'B' = 'B') {
  return {
    value,
    asOf: ISO,
    retrievedAt: ISO,
    sourceUrl: 'https://eastmoney.com/x',
    sourceTier: tier as 'A' | 'B' | 'C' | 'D' | 'E',
  };
}

function pack(
  facts: Partial<EvidencePackV2['facts']> = {},
): EvidencePackV2 {
  return {
    schemaVersion: 'evidence-pack-v2',
    symbol: '600519.SS',
    market: 'CN',
    capturedAt: ISO,
    facts,
    dataAvailability: { complete: [], missing: [], fallbacks: [] },
    citations: [],
    trace: { toolCalls: 1, durationMs: 1, costUsd: 0 },
  };
}

// ===== OK path =====

describe('validateCrossDim — OK path', () => {
  it('returns OK + no conflicts when all dims agree with EvidencePack', () => {
    const sections = [
      section('FUNDAMENTAL', { pe: 28.7, currency: 'CNY' }),
      section('VALUATION', { pe: 28.7, currency: 'CNY' }),
    ];
    const report = validateCrossDim(sections, {
      evidencePack: pack({ pe: fact(28.7) }),
      marketProfile: CN,
    });
    expect(report.overallStatus).toBe('OK');
    expect(report.conflicts).toHaveLength(0);
    expect(report.downgradedDimensions).toHaveLength(0);
    expect(report.summary.totalConflicts).toBe(0);
  });

  it('returns OK with empty sections', () => {
    const report = validateCrossDim([], { marketProfile: CN });
    expect(report.overallStatus).toBe('OK');
  });

  it('returns OK when no dim emits any extractable fact', () => {
    const sections = [
      section('FUNDAMENTAL'), // no PE/marketCap/price → only dataAsOf+currency=undefined
    ];
    // No priceTarget means no currency observation, dataAsOf present.
    // With only 1 obs and no EvidencePack, no ground truth → no conflicts.
    const report = validateCrossDim(sections, { marketProfile: CN });
    expect(report.overallStatus).toBe('OK');
  });
});

// ===== WARNING =====

describe('validateCrossDim — WARNING (small drift, no behavior change)', () => {
  it('flags PE deviation 1.5% (above warning 1%, below downgrade 5%)', () => {
    const sections = [
      section('FUNDAMENTAL', { pe: 28.7, confidence: 'HIGH' }),
      section('VALUATION', { pe: 29.14, confidence: 'HIGH' }), // ~1.53% off
    ];
    const report = validateCrossDim(sections, {
      evidencePack: pack({ pe: fact(28.7) }),
      marketProfile: CN,
    });
    expect(report.overallStatus).toBe('WARNING');
    expect(report.conflicts).toHaveLength(1);
    expect(report.conflicts[0]?.severity).toBe('WARNING');
    // No downgrade applied for WARNING-only.
    expect(report.downgradedDimensions).toHaveLength(0);
    expect(sections[1]?.structuredJson.conclusion.confidence).toBe('HIGH');
  });
});

// ===== DOWNGRADE =====

describe('validateCrossDim — DOWNGRADE (mutates confidence)', () => {
  it('PE deviation 7% triggers DOWNGRADE on the offending dim', () => {
    const sections = [
      section('FUNDAMENTAL', { pe: 28.7, confidence: 'HIGH' }),
      section('VALUATION', { pe: 30.7, confidence: 'HIGH' }), // ~6.97% off → DOWNGRADE
    ];
    const report = validateCrossDim(sections, {
      evidencePack: pack({ pe: fact(28.7) }),
      marketProfile: CN,
    });
    expect(report.overallStatus).toBe('DOWNGRADE');
    const conf = report.conflicts.find((c) => c.severity === 'DOWNGRADE');
    expect(conf?.factKey).toBe('pe');
    expect(report.downgradedDimensions).toHaveLength(1);
    expect(report.downgradedDimensions[0]?.type).toBe('VALUATION');
    expect(report.downgradedDimensions[0]?.originalConfidence).toBe('HIGH');
    expect(report.downgradedDimensions[0]?.downgradedTo).toBe('MEDIUM');
    // Mutation applied.
    expect(sections[1]?.structuredJson.conclusion.confidence).toBe('MEDIUM');
    // Other dim untouched.
    expect(sections[0]?.structuredJson.conclusion.confidence).toBe('HIGH');
  });

  it('LOW dim stays LOW (no underflow) but downgrade is still recorded', () => {
    const sections = [
      section('VALUATION', { pe: 30.7, confidence: 'LOW' }),
    ];
    const report = validateCrossDim(sections, {
      evidencePack: pack({ pe: fact(28.7) }),
      marketProfile: CN,
    });
    expect(report.downgradedDimensions).toHaveLength(1);
    expect(report.downgradedDimensions[0]?.originalConfidence).toBe('LOW');
    expect(report.downgradedDimensions[0]?.downgradedTo).toBe('LOW');
    expect(sections[0]?.structuredJson.conclusion.confidence).toBe('LOW');
  });

  it('one dim flagged on multiple facts only downgrades once', () => {
    const sections = [
      section('FUNDAMENTAL', { pe: 28.7, marketCapYi: 22875.6, confidence: 'HIGH' }),
      // VALUATION off on BOTH pe and marketCap
      section('VALUATION', {
        pe: 30.7,
        marketCapYi: 24000,
        confidence: 'HIGH',
      }),
    ];
    const report = validateCrossDim(sections, {
      evidencePack: pack({
        pe: fact(28.7),
        marketCap: fact(22875.6),
      }),
      marketProfile: CN,
    });
    expect(report.downgradedDimensions).toHaveLength(1);
    expect(report.downgradedDimensions[0]?.downgradedTo).toBe('MEDIUM');
    // Reason aggregates both facts.
    expect(report.downgradedDimensions[0]?.reason).toContain('pe');
    expect(report.downgradedDimensions[0]?.reason).toContain('marketCap');
  });
});

// ===== FAIL =====

describe('validateCrossDim — FAIL', () => {
  it('PE deviation 20% triggers FAIL', () => {
    const sections = [
      section('FUNDAMENTAL', { pe: 28.7, confidence: 'HIGH' }),
      section('VALUATION', { pe: 36, confidence: 'HIGH' }), // ~25% off → FAIL
    ];
    const report = validateCrossDim(sections, {
      evidencePack: pack({ pe: fact(28.7) }),
      marketProfile: CN,
    });
    expect(report.overallStatus).toBe('FAIL');
    expect(report.summary.severityCounts.FAIL).toBe(1);
  });

  it('currency mismatch is FAIL (market-profile lock)', () => {
    const sections = [
      section('FUNDAMENTAL', { currency: 'CNY', confidence: 'HIGH' }),
      section('VALUATION', { currency: 'USD', confidence: 'HIGH' }),
    ];
    const report = validateCrossDim(sections, { marketProfile: CN });
    expect(report.overallStatus).toBe('FAIL');
    const cur = report.conflicts.find((c) => c.factKey === 'currency');
    expect(cur?.severity).toBe('FAIL');
    expect(cur?.groundTruth?.source).toBe('market-profile');
  });

  it('dataAsOf spanning > 90 days is FAIL', () => {
    const sections = [
      section('FUNDAMENTAL', { dataAsOf: '2026-05-13' }),
      section('VALUATION', { dataAsOf: '2025-12-01' }), // ~163 days off
    ];
    const report = validateCrossDim(sections, {
      evidencePack: pack(), // capturedAt 2026-05-13
      marketProfile: CN,
    });
    expect(report.overallStatus).toBe('FAIL');
    const d = report.conflicts.find((c) => c.factKey === 'dataAsOf');
    expect(d?.severity).toBe('FAIL');
    expect(d?.maxDeviation).toBeGreaterThan(90);
  });
});

// ===== Ground truth ladder =====

describe('validateCrossDim — ground truth ladder', () => {
  it('uses EvidencePack value when available (highest authority)', () => {
    const sections = [section('FUNDAMENTAL', { pe: 28.7 })];
    const report = validateCrossDim(sections, {
      evidencePack: pack({ pe: fact(40) }), // pack says 40, dim says 28.7 → big delta
      marketProfile: CN,
    });
    const conf = report.conflicts.find((c) => c.factKey === 'pe');
    expect(conf?.groundTruth?.value).toBe(40);
    expect(conf?.groundTruth?.source).toBe('evidence-pack');
    expect(conf?.severity).toBe('FAIL'); // 28.7 vs 40 → ~28% deviation
  });

  it('falls back to dim-majority (3+ within 1%) when no EvidencePack', () => {
    // 28.6/28.7/28.8 cluster within 1% of median (28.8); 32 is the outlier.
    // (28.5 used earlier was 1.04% off 28.8 and fell outside the cluster,
    // breaking the 3-observation majority quorum — bumped to 28.6.)
    const sections = [
      section('FUNDAMENTAL', { pe: 28.7, confidence: 'HIGH' }),
      section('VALUATION', { pe: 28.6, confidence: 'HIGH' }),
      section('RISK', { pe: 28.8, confidence: 'HIGH' }),
      section('SENTIMENT', { pe: 32, confidence: 'HIGH' }), // outlier
    ];
    const report = validateCrossDim(sections, { marketProfile: CN });
    const conf = report.conflicts.find((c) => c.factKey === 'pe');
    expect(conf?.groundTruth?.source).toBe('dim-majority');
    expect(conf?.observations[0]?.sectionType).toBe('SENTIMENT');
  });

  it('skips fact when no ground truth available (< 3 obs, no pack)', () => {
    const sections = [
      section('FUNDAMENTAL', { pe: 28.7 }),
      section('VALUATION', { pe: 40 }), // 2 obs only, no majority
    ];
    const report = validateCrossDim(sections, { marketProfile: CN });
    expect(report.conflicts.filter((c) => c.factKey === 'pe')).toHaveLength(0);
  });

  it('currency uses market-profile even when EvidencePack provides one', () => {
    const sections = [section('FUNDAMENTAL', { currency: 'USD' })];
    const report = validateCrossDim(sections, {
      evidencePack: pack(),
      marketProfile: CN, // CNY
    });
    const conf = report.conflicts.find((c) => c.factKey === 'currency');
    expect(conf?.groundTruth?.source).toBe('market-profile');
    expect(conf?.groundTruth?.value).toBe('CNY');
  });
});

// ===== Tolerance override =====

describe('validateCrossDim — tolerance override', () => {
  it('respects toleranceOverride > marketProfile.crossDimTolerance', () => {
    const sections = [
      section('FUNDAMENTAL', { pe: 28.7, confidence: 'HIGH' }),
      section('VALUATION', { pe: 30.7, confidence: 'HIGH' }), // 7% off
    ];
    const report = validateCrossDim(sections, {
      evidencePack: pack({ pe: fact(28.7) }),
      marketProfile: CN,
      // Override: way more lenient — 7% becomes only WARNING.
      toleranceOverride: {
        ...DEFAULT_CROSS_DIM_TOLERANCE,
        pe: { warning: 5, downgrade: 10, fail: 20 },
      },
    });
    expect(report.overallStatus).toBe('WARNING');
    expect(report.downgradedDimensions).toHaveLength(0);
  });
});

// ===== Summary correctness =====

describe('validateCrossDim — summary', () => {
  it('severityCounts and totalConflicts match conflicts array', () => {
    const sections = [
      section('FUNDAMENTAL', { pe: 28.7, currency: 'CNY' }),
      section('VALUATION', { pe: 29.2, currency: 'USD' }), // 1.7% PE = WARNING, USD = FAIL
    ];
    const report = validateCrossDim(sections, {
      evidencePack: pack({ pe: fact(28.7) }),
      marketProfile: CN,
    });
    const counts = report.summary.severityCounts;
    expect(counts.WARNING + counts.DOWNGRADE + counts.FAIL).toBe(
      report.summary.totalConflicts,
    );
    expect(report.summary.totalConflicts).toBe(report.conflicts.length);
    expect(counts.FAIL).toBeGreaterThanOrEqual(1); // currency FAIL
  });

  it('durationMs is non-negative', () => {
    const report = validateCrossDim([], { marketProfile: CN });
    expect(report.summary.durationMs).toBeGreaterThanOrEqual(0);
  });
});
