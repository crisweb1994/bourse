import { describe, expect, it } from 'vitest';
import { AnalysisResult, SCHEMA_VERSION, SectionResult } from '../../contracts/analysis-result';

const citation = {
  title: 'Source',
  url: 'https://example.com/source',
  sourceType: 'NEWS' as const,
  retrievedAt: '2026-01-15T10:30:00.000Z',
};

const finding = {
  title: 'Finding',
  conclusion: 'A grounded conclusion',
  evidence: [{ claim: 'A grounded claim', citations: [citation] }],
};

const section = {
  schemaVersion: SCHEMA_VERSION,
  type: 'COMPANY_QUALITY' as const,
  assessment: 'MIXED' as const,
  confidence: 'MEDIUM' as const,
  summary: 'Mixed quality',
  findings: [finding],
  limitations: [],
  dataAsOf: '2026-01-15',
  disclaimer: 'Disclaimer',
};

const summary = {
  headline: 'Neutral',
  signal: null,
  confidence: 'LOW' as const,
  rationale: [],
  counterpoints: [],
  changeConditions: [],
  missingSections: ['VALUATION_SCENARIOS' as const],
  dataAsOf: '2026-01-15',
  disclaimer: 'Disclaimer',
};

const trace = {
  llmCalls: 1,
  toolCalls: 1,
  tokensIn: 10,
  tokensOut: 20,
  durationMs: 100,
};

describe('AnalysisResult V2 contracts', () => {
  it('parses each fixed section shape', () => {
    expect(SectionResult.parse(section).type).toBe('COMPANY_QUALITY');
    expect(SectionResult.parse({ ...section, type: 'MARKET_SIGNALS', assessment: 'NEUTRAL' }).type)
      .toBe('MARKET_SIGNALS');
  });

  it('parses a completed report and a failed report without structured JSON', () => {
    expect(AnalysisResult.parse({
      reportMarkdown: '# Report',
      structuredJson: summary,
      citations: [citation],
      status: 'COMPLETED',
      confidence: 'LOW',
      trace,
      warnings: [],
    }).status).toBe('COMPLETED');
    expect(AnalysisResult.parse({
      reportMarkdown: '',
      structuredJson: null,
      citations: [],
      status: 'FAILED',
      confidence: 'LOW',
      trace,
      warnings: ['failed'],
    }).structuredJson).toBeNull();
  });

  it('rejects legacy section names and statuses', () => {
    expect(() => SectionResult.parse({ ...section, type: 'FUNDAMENTAL' })).toThrow();
    expect(() => AnalysisResult.parse({
      reportMarkdown: '',
      structuredJson: null,
      citations: [],
      status: 'BUDGET_EXHAUSTED',
      confidence: 'LOW',
      trace,
      warnings: [],
    })).toThrow();
  });
});
