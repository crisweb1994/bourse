import type { BaseSectionData } from '@bourse/shared-types';
import { describe, expect, it } from 'vitest';
import {
  AnalysisResult,
  SCHEMA_VERSION,
  StructuredJson,
} from '../../contracts/analysis-result';

const validCitation = {
  title: 'Synthetic source',
  url: 'https://example.com/test',
  sourceType: 'NEWS' as const,
  retrievedAt: '2026-01-15T10:30:00Z',
};

const validBaselineJson = {
  schemaVersion: SCHEMA_VERSION,
  conclusion: {
    signal: 'NEUTRAL' as const,
    confidence: 'MEDIUM' as const,
    oneLiner: 'A synthetic test conclusion.',
    evidence: [],
  },
  evidence: [{ claim: 'Synthetic claim', citations: [validCitation] }],
  dataAvailability: { missingFields: [], reason: 'Test data complete.' },
  dataAsOf: '2026-01-15',
  disclaimer: 'Test disclaimer.',
};

describe('contracts/StructuredJson — baseline', () => {
  it('parses with only baseline fields', () => {
    expect(StructuredJson.parse(validBaselineJson).schemaVersion).toBe(
      SCHEMA_VERSION,
    );
  });

  it('locks schemaVersion literal', () => {
    expect(() =>
      StructuredJson.parse({ ...validBaselineJson, schemaVersion: 'agent-result-v2' }),
    ).toThrow();
  });

  it('enforces dataAsOf YYYY-MM-DD format', () => {
    expect(() =>
      StructuredJson.parse({ ...validBaselineJson, dataAsOf: '2026/01/15' }),
    ).toThrow();
    expect(() =>
      StructuredJson.parse({ ...validBaselineJson, dataAsOf: 'Jan 15 2026' }),
    ).toThrow();
  });

  it('rejects empty disclaimer (code injects fixed text)', () => {
    expect(() =>
      StructuredJson.parse({ ...validBaselineJson, disclaimer: '' }),
    ).toThrow();
  });
});

describe('contracts/StructuredJson — optional enhancements', () => {
  it('accepts recommendation + priceTarget + thesis', () => {
    const enhanced = {
      ...validBaselineJson,
      recommendation: 'HOLD' as const,
      priceTarget: { base: 100, currency: 'USD', horizonDays: 90 },
      thesis: 'Synthetic thesis.',
    };
    expect(StructuredJson.parse(enhanced).priceTarget?.base).toBe(100);
  });

  it('rejects dimensionScores out of [0, 100]', () => {
    expect(() =>
      StructuredJson.parse({
        ...validBaselineJson,
        dimensionScores: { FUNDAMENTAL: 150 },
      }),
    ).toThrow();
    expect(() =>
      StructuredJson.parse({
        ...validBaselineJson,
        dimensionScores: { FUNDAMENTAL: -1 },
      }),
    ).toThrow();
  });

  it('rejects unknown dimension key in dimensionScores', () => {
    expect(() =>
      StructuredJson.parse({
        ...validBaselineJson,
        dimensionScores: { NOT_A_DIM: 50 },
      }),
    ).toThrow();
  });

  it('accepts factReferences as array of strings (RFC-02 §13)', () => {
    const refs = ['quote', 'pe', 'consensusEps', 'latestFilingUrls'];
    const parsed = StructuredJson.parse({
      ...validBaselineJson,
      factReferences: refs,
    });
    expect(parsed.factReferences).toEqual(refs);
  });

  it('factReferences is optional — baseline still validates without it', () => {
    const parsed = StructuredJson.parse(validBaselineJson);
    expect(parsed.factReferences).toBeUndefined();
  });

  it('rejects factReferences with non-string entries', () => {
    expect(() =>
      StructuredJson.parse({
        ...validBaselineJson,
        factReferences: ['quote', 123],
      }),
    ).toThrow();
  });
});

describe('contracts/AnalysisResult', () => {
  const validResult = {
    reportMarkdown: '# Synthetic report',
    structuredJson: validBaselineJson,
    citations: [validCitation],
    status: 'COMPLETED' as const,
    signal: 'NEUTRAL' as const,
    confidence: 'MEDIUM' as const,
    trace: {
      llmCalls: 1,
      toolCalls: 1,
      tokensIn: 100,
      tokensOut: 50,
      totalUsd: 0.001,
      durationMs: 500,
    },
    warnings: [],
  };

  it('parses a minimal complete result', () => {
    expect(AnalysisResult.parse(validResult).status).toBe('COMPLETED');
  });

  it('accepts BUDGET_EXHAUSTED status with partialDimensions', () => {
    const partial = {
      ...validResult,
      status: 'BUDGET_EXHAUSTED' as const,
      partialDimensions: ['SCENARIO' as const, 'PORTFOLIO' as const],
      warnings: ['Cost cap reached after 6/8 dimensions.'],
    };
    expect(AnalysisResult.parse(partial).partialDimensions).toEqual([
      'SCENARIO',
      'PORTFOLIO',
    ]);
  });

  it('requires warnings array (even if empty)', () => {
    const noWarnings: Record<string, unknown> = { ...validResult };
    delete noWarnings.warnings;
    expect(() => AnalysisResult.parse(noWarnings)).toThrow();
  });
});

describe('contracts/AnalysisResult — union structuredJson + nullable', () => {
  const validResult = {
    reportMarkdown: '# Synthetic report',
    structuredJson: validBaselineJson,
    citations: [validCitation],
    status: 'COMPLETED' as const,
    signal: 'NEUTRAL' as const,
    confidence: 'MEDIUM' as const,
    trace: {
      llmCalls: 1,
      toolCalls: 1,
      tokensIn: 100,
      tokensOut: 50,
      totalUsd: 0.001,
      durationMs: 500,
    },
    warnings: [],
  };

  const validSummary = {
    overallSignal: 'BULLISH' as const,
    overallConfidence: 'HIGH' as const,
    oneLiner: '综合看好',
    bullCase: ['理由1'],
    bearCase: [],
    biggestRisk: '宏观',
    valuationConclusion: '合理',
    suitableInvestorType: '稳健',
    watchlistWorthy: true,
    sectionSignals: [],
    evidence: [],
    dataAsOf: '2026-05-10',
    disclaimer: '免责',
  };

  it('accepts a per-dimension StructuredJson', () => {
    expect(
      AnalysisResult.parse(validResult).structuredJson,
    ).toMatchObject({ schemaVersion: SCHEMA_VERSION });
  });

  it('accepts a ComprehensiveSummary as structuredJson', () => {
    const compResult = { ...validResult, structuredJson: validSummary };
    const parsed = AnalysisResult.parse(compResult);
    expect(parsed.structuredJson).not.toBeNull();
    if (parsed.structuredJson && 'overallSignal' in parsed.structuredJson) {
      expect(parsed.structuredJson.overallSignal).toBe('BULLISH');
    }
  });

  it('accepts null structuredJson for failed runs', () => {
    const failedResult = {
      ...validResult,
      status: 'FAILED' as const,
      structuredJson: null,
    };
    expect(AnalysisResult.parse(failedResult).structuredJson).toBeNull();
  });
});

describe('type compatibility with shared-types BaseSectionData', () => {
  it('StructuredJson is structurally a superset of BaseSectionData', () => {
    // Type-level check: passing a parsed StructuredJson where BaseSectionData
    // is expected must compile. Forces baseline drift to be caught at build.
    const parsed = StructuredJson.parse(validBaselineJson);
    const _asBase: BaseSectionData = parsed;
    expect(_asBase.dataAsOf).toBe('2026-01-15');
  });
});
