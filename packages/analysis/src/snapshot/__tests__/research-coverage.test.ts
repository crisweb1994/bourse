import { describe, expect, it } from 'vitest';
import type { StructuredJson } from '../../contracts/analysis-result';
import {
  applyResearchCoverage,
  buildResearchCoverage,
  shouldSkipForCoverage,
} from '../research-coverage';

function result(): StructuredJson {
  return {
    schemaVersion: 'agent-result-v1',
    conclusion: {
      signal: 'BULLISH',
      confidence: 'HIGH',
      oneLiner: 'x',
      evidence: [],
    },
    evidence: [],
    dataAvailability: { missingFields: [], reason: '' },
    dataAsOf: '2026-07-26',
    disclaimer: 'd',
    priceTarget: { base: 120, currency: 'USD', horizonDays: 365 },
  };
}

describe('research coverage', () => {
  it('allows high confidence only when core source facts are present', () => {
    const coverage = buildResearchCoverage(
      new Set(['quote', 'history', 'financials', 'filings', 'macro', 'profile']),
    );
    expect(coverage.overallStatus).toBe('PASS');
    expect(coverage.overallConfidenceCap).toBe('HIGH');
    expect(coverage.dimensions.VALUATION!.minimumViable).toBe(true);
  });

  it('marks valuation and scenario insufficient when financials are absent', () => {
    const coverage = buildResearchCoverage(new Set(['quote', 'history', 'profile']));
    expect(coverage.overallStatus).toBe('INSUFFICIENT_EVIDENCE');
    expect(coverage.dimensions.VALUATION!).toMatchObject({
      status: 'INSUFFICIENT_EVIDENCE',
      confidenceCap: 'LOW',
      missingCriticalFacts: ['financials'],
    });
    expect(coverage.dimensions.SCENARIO!.missingCriticalFacts).toEqual([
      'financials',
      'macro',
    ]);
  });

  it('skips technical only when quote or history is unavailable', () => {
    const coverage = buildResearchCoverage(new Set(['quote', 'financials']));
    const technical = shouldSkipForCoverage(coverage, 'TECHNICAL');
    expect(technical?.missingCriticalFacts).toEqual(['history']);
    expect(shouldSkipForCoverage(coverage, 'VALUATION')).toBeUndefined();
  });

  it('caps confidence, carries missing facts, and removes blocked target prices', () => {
    const coverage = buildResearchCoverage(new Set(['quote', 'history', 'profile']));
    const gated = applyResearchCoverage(result(), coverage.dimensions.VALUATION);
    expect(gated.conclusion.confidence).toBe('LOW');
    expect(gated.priceTarget).toBeUndefined();
    expect(gated.dataAvailability.missingFields).toEqual(['financials']);
    expect(gated.dataAvailability.reason).toContain('INSUFFICIENT_EVIDENCE');
  });

  it('downgrades a complete but stale core fact set instead of treating it as fresh', () => {
    const coverage = buildResearchCoverage(
      new Set(['quote', 'history', 'financials', 'filings', 'macro', 'profile']),
      new Set(['macro']),
    );
    expect(coverage.overallStatus).toBe('DEGRADED');
    expect(coverage.overallConfidenceCap).toBe('MEDIUM');
    expect(coverage.dimensions.SCENARIO!.staleFacts).toEqual(['macro']);
    expect(coverage.dimensions.SCENARIO!.confidenceCap).toBe('MEDIUM');
  });
});
