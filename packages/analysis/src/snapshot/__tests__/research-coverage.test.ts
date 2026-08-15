import { describe, expect, it } from 'vitest';
import { buildResearchCoverage, applyResearchCoverage, shouldSkipForCoverage } from '../research-coverage';
import type { SectionResult } from '../../contracts/analysis-result';

const section: SectionResult = {
  schemaVersion: 'analysis-section-v2',
  type: 'VALUATION_SCENARIOS',
  assessment: 'FAIR', confidence: 'HIGH', summary: 'summary', findings: [], limitations: [],
  dataAsOf: '2026-01-15', disclaimer: 'D', methods: [], scenarios: [],
};

describe('research coverage V2', () => {
  it('marks the fixed module requirements', () => {
    const coverage = buildResearchCoverage(new Set(['quote', 'history', 'profile', 'financials', 'filings', 'macro']));
    expect(coverage.overallStatus).toBe('PASS');
    expect(coverage.dimensions.VALUATION_SCENARIOS!.minimumViable).toBe(true);
    expect(coverage.dimensions.MARKET_SIGNALS!.skip).toBe(false);
  });

  it('skips market signals when quote or history is missing', () => {
    const coverage = buildResearchCoverage(new Set(['financials', 'profile']));
    expect(shouldSkipForCoverage(coverage, 'MARKET_SIGNALS')).toMatchObject({
      missingCriticalFacts: ['quote', 'history'],
      status: 'INSUFFICIENT_EVIDENCE',
    });
  });

  it('caps an otherwise overconfident result when required facts are missing', () => {
    const coverage = buildResearchCoverage(new Set(['quote']));
    const gated = applyResearchCoverage(section, coverage.dimensions.VALUATION_SCENARIOS!);
    expect(gated.assessment).toBe('UNASSESSABLE');
    expect(gated.confidence).toBe('LOW');
    expect(gated.limitations.join('\n')).toContain('financials');
  });
});
