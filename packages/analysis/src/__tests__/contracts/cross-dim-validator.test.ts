import { describe, expect, it } from 'vitest';
import {
  ConflictSeverity,
  CrossDimTolerance,
  DEFAULT_CROSS_DIM_TOLERANCE,
  DowngradeRecord,
  FactConflict,
  FactObservation,
  OverallStatus,
  ToleranceTriple,
  VALIDATED_FACT_KEYS,
  ValidatorReport,
  downgradeConfidence,
} from '../../contracts/cross-dim-validator';

describe('contracts/cross-dim-validator — ConflictSeverity + OverallStatus enums', () => {
  it('ConflictSeverity has WARNING/DOWNGRADE/FAIL only', () => {
    expect(ConflictSeverity.options.sort()).toEqual([
      'DOWNGRADE',
      'FAIL',
      'WARNING',
    ]);
  });

  it('OverallStatus has OK in addition (run can pass with no conflicts)', () => {
    expect(OverallStatus.options.sort()).toEqual([
      'DOWNGRADE',
      'FAIL',
      'OK',
      'WARNING',
    ]);
  });

  it('rejects unknown severities', () => {
    expect(() => ConflictSeverity.parse('INFO')).toThrow();
    expect(() => OverallStatus.parse('PARTIAL')).toThrow();
  });
});

describe('contracts/cross-dim-validator — FactObservation', () => {
  it('requires sectionType + value + extractedFrom', () => {
    const valid = {
      sectionType: 'FUNDAMENTAL' as const,
      value: 28.7,
      extractedFrom: 'reportMarkdown:regex:pe',
    };
    expect(FactObservation.parse(valid).extractedFrom).toBe(
      'reportMarkdown:regex:pe',
    );
  });

  it('accepts arbitrary value shape (string/number/null)', () => {
    expect(
      FactObservation.parse({
        sectionType: 'FUNDAMENTAL',
        value: null,
        extractedFrom: 'structuredJson.priceTarget.base',
      }).value,
    ).toBeNull();
    expect(
      FactObservation.parse({
        sectionType: 'VALUATION',
        value: 'CNY',
        extractedFrom: 'structuredJson.priceTarget.currency',
      }).value,
    ).toBe('CNY');
  });

  it('rejects empty extractedFrom', () => {
    expect(() =>
      FactObservation.parse({
        sectionType: 'FUNDAMENTAL',
        value: 1,
        extractedFrom: '',
      }),
    ).toThrow();
  });
});

describe('contracts/cross-dim-validator — FactConflict', () => {
  const baseConflict = {
    factKey: 'pe',
    severity: 'DOWNGRADE' as const,
    observations: [
      {
        sectionType: 'FUNDAMENTAL' as const,
        value: 28.7,
        extractedFrom: 'reportMarkdown:regex:pe',
      },
      {
        sectionType: 'VALUATION' as const,
        value: 30.2,
        extractedFrom: 'reportMarkdown:regex:pe',
      },
    ],
    maxDeviation: 4.5,
    message: 'PE varies 4.5% across FUNDAMENTAL and VALUATION',
  };

  it('parses with all fields', () => {
    const parsed = FactConflict.parse({
      ...baseConflict,
      groundTruth: { value: 28.5, source: 'evidence-pack' as const },
    });
    expect(parsed.groundTruth?.source).toBe('evidence-pack');
    expect(parsed.observations).toHaveLength(2);
  });

  it('groundTruth is optional (dim-majority + no consensus → missing)', () => {
    const parsed = FactConflict.parse(baseConflict);
    expect(parsed.groundTruth).toBeUndefined();
  });

  it('rejects negative maxDeviation', () => {
    expect(() =>
      FactConflict.parse({ ...baseConflict, maxDeviation: -1 }),
    ).toThrow();
  });

  it('rejects empty message (callers must always explain)', () => {
    expect(() =>
      FactConflict.parse({ ...baseConflict, message: '' }),
    ).toThrow();
  });
});

describe('contracts/cross-dim-validator — DowngradeRecord', () => {
  it('captures original + downgraded confidence', () => {
    const parsed = DowngradeRecord.parse({
      type: 'VALUATION' as const,
      originalConfidence: 'HIGH' as const,
      downgradedTo: 'MEDIUM' as const,
      reason: 'PE deviation 4.5% from EvidencePack ground truth',
    });
    expect(parsed.originalConfidence).toBe('HIGH');
    expect(parsed.downgradedTo).toBe('MEDIUM');
  });

  it('reason is required (no silent confidence drops)', () => {
    expect(() =>
      DowngradeRecord.parse({
        type: 'VALUATION',
        originalConfidence: 'HIGH',
        downgradedTo: 'MEDIUM',
        reason: '',
      }),
    ).toThrow();
  });
});

describe('contracts/cross-dim-validator — ValidatorReport envelope', () => {
  it('parses minimal OK report (no conflicts)', () => {
    const parsed = ValidatorReport.parse({
      overallStatus: 'OK' as const,
      conflicts: [],
      downgradedDimensions: [],
      summary: {
        totalConflicts: 0,
        severityCounts: { WARNING: 0, DOWNGRADE: 0, FAIL: 0 },
        durationMs: 12,
      },
    });
    expect(parsed.overallStatus).toBe('OK');
    expect(parsed.summary.totalConflicts).toBe(0);
  });

  it('parses FAIL report with conflict + no downgrades (FAIL skips summary)', () => {
    const parsed = ValidatorReport.parse({
      overallStatus: 'FAIL' as const,
      conflicts: [
        {
          factKey: 'currency',
          severity: 'FAIL' as const,
          observations: [
            {
              sectionType: 'VALUATION' as const,
              value: 'USD',
              extractedFrom: 'structuredJson.priceTarget.currency',
            },
          ],
          groundTruth: {
            value: 'CNY',
            source: 'market-profile' as const,
          },
          message: 'VALUATION used USD for a CN-listed symbol',
        },
      ],
      downgradedDimensions: [],
      summary: {
        totalConflicts: 1,
        severityCounts: { WARNING: 0, DOWNGRADE: 0, FAIL: 1 },
        durationMs: 8,
      },
    });
    expect(parsed.overallStatus).toBe('FAIL');
    expect(parsed.conflicts[0]?.groundTruth?.source).toBe('market-profile');
  });
});

describe('contracts/cross-dim-validator — DEFAULT_CROSS_DIM_TOLERANCE', () => {
  it('passes schema validation', () => {
    expect(() => CrossDimTolerance.parse(DEFAULT_CROSS_DIM_TOLERANCE)).not.toThrow();
  });

  it('has the RFC-03 §7 default thresholds', () => {
    expect(DEFAULT_CROSS_DIM_TOLERANCE.price).toEqual({
      warning: 0.5,
      downgrade: 1.0,
      fail: 5.0,
    });
    expect(DEFAULT_CROSS_DIM_TOLERANCE.pe).toEqual({
      warning: 1.0,
      downgrade: 5.0,
      fail: 15.0,
    });
    expect(DEFAULT_CROSS_DIM_TOLERANCE.marketCap).toEqual({
      warning: 1.0,
      downgrade: 3.0,
      fail: 5.0,
    });
  });

  it('ToleranceTriple rejects negative thresholds', () => {
    expect(() =>
      ToleranceTriple.parse({ warning: -0.1, downgrade: 1, fail: 5 }),
    ).toThrow();
  });
});

describe('contracts/cross-dim-validator — VALIDATED_FACT_KEYS', () => {
  it('covers the RFC-03 §6.1 5-fact baseline', () => {
    expect([...VALIDATED_FACT_KEYS].sort()).toEqual([
      'currency',
      'dataAsOf',
      'marketCap',
      'pe',
      'price',
    ]);
  });
});

describe('contracts/cross-dim-validator — downgradeConfidence', () => {
  it('HIGH → MEDIUM', () => {
    expect(downgradeConfidence('HIGH')).toBe('MEDIUM');
  });

  it('MEDIUM → LOW', () => {
    expect(downgradeConfidence('MEDIUM')).toBe('LOW');
  });

  it('LOW stays at LOW (no underflow)', () => {
    expect(downgradeConfidence('LOW')).toBe('LOW');
  });
});
