import { describe, expect, it } from 'vitest';
import {
  AnalysisResult,
  enforceComputedValueRanges,
  SCHEMA_VERSION,
  SectionResult,
} from '../../contracts/analysis-result';

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

  it('drops legacy calculationId fields on valuation value ranges', () => {
    const parsed = SectionResult.parse({
      ...section,
      type: 'VALUATION_SCENARIOS',
      assessment: 'FAIR',
      scenarios: [{
        case: 'BASE',
        assumptions: ['增速持平'],
        valueRange: {
          low: 90,
          high: 110,
          currency: 'USD',
          calculationId: 'legacy-id',
        },
        invalidators: [],
      }],
    });
    expect(parsed.type === 'VALUATION_SCENARIOS' && parsed.scenarios[0]?.valueRange)
      .toEqual({ low: 90, high: 110, currency: 'USD' });
  });

  it('forces valuation value ranges to null without a computed valuation', () => {
    const valuation = SectionResult.parse({
      ...section,
      type: 'VALUATION_SCENARIOS',
      assessment: 'FAIR',
      scenarios: [{
        case: 'BASE',
        assumptions: [],
        valueRange: { low: 90, high: 110, currency: 'USD' },
        invalidators: [],
      }],
    });
    const enforced = enforceComputedValueRanges(valuation, false);
    expect(
      enforced.type === 'VALUATION_SCENARIOS' && enforced.scenarios[0]?.valueRange,
    ).toBeNull();

    const kept = enforceComputedValueRanges(valuation, true);
    expect(
      kept.type === 'VALUATION_SCENARIOS' && kept.scenarios[0]?.valueRange,
    ).toEqual({ low: 90, high: 110, currency: 'USD' });

    // Non-valuation sections pass through untouched.
    const company = SectionResult.parse(section);
    expect(enforceComputedValueRanges(company, false)).toBe(company);
  });

  it('normalizes descriptive risk severity fields from provider output', () => {
    const parsed = SectionResult.parse({
      ...section,
      type: 'RISK_REGISTER',
      assessment: 'MEDIUM',
      risks: [{
        title: '投入风险',
        mechanism: '资本开支上升',
        likelihood: '较高',
        impact: '压缩增长预期、削弱自由现金流',
        indicators: [],
        invalidates: [],
        evidence: [],
      }],
      basedOnIncompleteSections: [],
    });
    expect(parsed.type === 'RISK_REGISTER' && parsed.risks[0]).toMatchObject({
      likelihood: 'HIGH',
      impact: 'MEDIUM',
    });
  });
});
