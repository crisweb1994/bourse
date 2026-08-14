import { describe, expect, it } from 'vitest';
import { applyEvidenceGate } from '../../primitives/evidence-gate';
import type { SectionResult } from '../../contracts/analysis-result';

const base: SectionResult = {
  schemaVersion: 'analysis-section-v2',
  type: 'COMPANY_QUALITY',
  assessment: 'MIXED',
  confidence: 'HIGH',
  summary: 'Summary',
  findings: [{
    title: 'Finding',
    conclusion: 'Conclusion',
    evidence: [{
      claim: 'Claim',
      citations: [{
        title: 'Source',
        url: 'https://example.com/source',
        sourceType: 'NEWS',
        retrievedAt: '2026-01-15T10:00:00.000Z',
        qualityTier: 'A',
      }],
    }],
  }],
  limitations: [],
  dataAsOf: '2026-01-15',
  disclaimer: 'Disclaimer',
};

describe('evidence gate V2', () => {
  it('keeps grounded evidence and reports whether evidence exists', () => {
    const result = applyEvidenceGate(base);
    expect(result.noEvidence).toBe(false);
    expect(result.data.findings[0]?.evidence[0]?.citations[0]?.qualityTier).toBe('A');
  });

  it('downgrades a model-declared source tier when the domain profile is weaker', () => {
    const result = applyEvidenceGate(base, { domainTiers: { 'example.com': 'D' } });
    expect(result.data.findings[0]?.evidence[0]?.citations[0]?.qualityTier).toBe('D');
    expect(result.warnings).toHaveLength(1);
  });

  it('does not invent evidence for a finding with no citations', () => {
    const result = applyEvidenceGate({
      ...base,
      findings: [{ ...base.findings[0]!, evidence: [] }],
    });
    expect(result.noEvidence).toBe(true);
  });
});
