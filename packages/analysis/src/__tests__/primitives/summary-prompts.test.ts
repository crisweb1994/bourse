import { describe, expect, it } from 'vitest';
import {
  buildSummaryJsonPrompts,
  buildSummaryPrompts,
  ComprehensiveSummaryLenient,
  hydrateSummaryCitations,
  normalizeSummarySignal,
} from '../../primitives/summary-prompts';

const today = '2026-01-15';
const summary = {
  headline: '中性',
  signal: 'POSITIVE' as const,
  confidence: 'HIGH' as const,
  rationale: [{ claim: '支持', citations: [{ title: 'S', url: 'https://example.com/a' }] }],
  counterpoints: [],
  changeConditions: [],
  missingSections: [],
  dataAsOf: today,
  disclaimer: 'D',
};

describe('summary prompts V2', () => {
  it('restricts the summary to completed modules and carries missing critical modules', () => {
    const prompts = buildSummaryPrompts(
      '### COMPANY_QUALITY\nreport', today,
      ['COMPANY_QUALITY'], ['VALUATION_SCENARIOS'], '重点问题', ['VALUATION_SCENARIOS'],
    );
    expect(prompts.system).toContain('研究模块');
    expect(prompts.system).toContain('signal 必须为 null');
    expect(prompts.user).toContain('重点问题');
    expect(prompts.user).toContain('COMPANY_QUALITY');
  });

  it('requires summary fields and source provenance', () => {
    const prompts = buildSummaryJsonPrompts('markdown summary');
    expect(prompts.system).toContain('headline');
    expect(prompts.system).toContain('sourceType');
    expect(prompts.user).toContain('markdown summary');
  });

  it('hydrates citation metadata and gates signal when required data is missing', () => {
    const hydrated = hydrateSummaryCitations(summary, [{
      title: 'S', url: 'https://example.com/a', sourceType: 'FILING',
      retrievedAt: '2026-01-15T10:00:00.000Z',
    }], today);
    expect(hydrated.rationale[0]?.citations[0]?.sourceType).toBe('FILING');
    expect(normalizeSummarySignal(hydrated, ['VALUATION_SCENARIOS']).signal).toBeNull();
  });

  it('accepts legacy evidence strings and object-shaped change conditions', () => {
    const parsed = ComprehensiveSummaryLenient.safeParse({
      headline: '旧格式总结',
      signal: 'NEUTRAL',
      confidence: 'MEDIUM',
      rationale: [{ text: '支持因素' }],
      counterpoints: ['反向因素'],
      changeConditions: [{ condition: '下一次财报低于预期' }],
      missingSections: [],
      dataAsOf: today,
      disclaimer: 'D',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.rationale[0]?.claim).toBe('支持因素');
      expect(parsed.data.counterpoints[0]?.claim).toBe('反向因素');
      expect(parsed.data.changeConditions).toEqual(['下一次财报低于预期']);
    }
  });

  it('accepts a single legacy evidence object and case-insensitive signals', () => {
    const parsed = ComprehensiveSummaryLenient.safeParse({
      headline: '旧格式总结',
      overallSignal: 'bullish',
      overallConfidence: 'medium',
      rationale: { point: '支持因素' },
      counterpoints: { description: '反向因素' },
      changeConditions: '下一次财报低于预期',
      missingSections: [],
      dataAsOf: today,
      disclaimer: 'D',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.signal).toBe('POSITIVE');
      expect(parsed.data.rationale[0]?.claim).toBe('支持因素');
      expect(parsed.data.counterpoints[0]?.claim).toBe('反向因素');
      expect(parsed.data.changeConditions).toEqual(['下一次财报低于预期']);
    }
  });
});
