import { describe, expect, it } from 'vitest';
import {
  buildSummaryJsonPrompts,
  buildSummaryPrompts,
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
    expect(prompts.system).toContain('五个研究模块');
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
});
