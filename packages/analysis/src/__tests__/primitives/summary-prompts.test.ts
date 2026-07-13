import { describe, expect, it } from 'vitest';
import { SCHEMA_VERSION } from '../../contracts/analysis-result';
import type { Citation } from '../../contracts/citation';
import type { DimensionRunResult } from '../../dimensions/types';
import {
  buildSectionReports,
  buildSummaryJsonPrompts,
  buildSummaryPrompts,
  ComprehensiveSummaryLenient,
  hydrateSummaryCitations,
} from '../../primitives/summary-prompts';

const TODAY = '2026-05-10';

function makeDimResult(type: 'FUNDAMENTAL' | 'TECHNICAL', md: string): DimensionRunResult {
  return {
    type,
    reportMarkdown: md,
    structuredJson: {
      schemaVersion: SCHEMA_VERSION,
      conclusion: { signal: 'NEUTRAL', confidence: 'MEDIUM', oneLiner: 'x', evidence: [] },
      evidence: [],
      dataAvailability: { missingFields: [], reason: '' },
      dataAsOf: TODAY,
      disclaimer: 'd',
    },
    citations: [],
    signal: 'NEUTRAL',
    confidence: 'MEDIUM',
    score: 50,
    status: 'COMPLETED',
    warnings: [],
    usage: { tokensIn: 0, tokensOut: 0 },
  };
}

describe('primitives/buildSummaryPrompts', () => {
  it('carries the research focus into the comprehensive conclusion', () => {
    const { user } = buildSummaryPrompts(
      'reports',
      TODAY,
      ['FUNDAMENTAL'],
      [],
      '毛利率下滑是短期波动吗？',
    );
    expect(user).toContain('【本次研究焦点】');
    expect(user).toContain('毛利率下滑是短期波动吗？');
    expect(user).toContain('区分事实、推断与仍不确定的信息');
  });

  it('system contains the analyst role + 9 numbered sections', () => {
    const { system } = buildSummaryPrompts('reports here', TODAY, [
      'FUNDAMENTAL',
      'VALUATION',
      'INDUSTRY',
      'RISK',
      'TECHNICAL',
      'SENTIMENT',
      'SCENARIO',
      'PORTFOLIO',
    ]);
    expect(system).toContain('资深首席投资分析师');
    for (const n of ['1.', '2.', '3.', '4.', '5.', '6.', '7.', '8.', '9.']) {
      expect(system).toContain(n);
    }
  });

  it('appends COMMON_SUFFIX (freshness + output rules)', () => {
    const { system } = buildSummaryPrompts('reports', TODAY, ['FUNDAMENTAL']);
    expect(system).toContain('## 数据时效');
    expect(system).toContain('## 输出要求');
    expect(system).toContain(`今日日期：${TODAY}`);
  });

  it('user embeds the section reports payload', () => {
    const { user } = buildSummaryPrompts('SOME_SECTION_REPORTS', TODAY, [
      'FUNDAMENTAL',
    ]);
    expect(user).toContain('SOME_SECTION_REPORTS');
    expect(user).toContain('请生成综合投资总览报告');
  });

  it('reflects the actual count of available dimensions', () => {
    const types = ['FUNDAMENTAL', 'VALUATION', 'TECHNICAL'] as const;
    const { system, user } = buildSummaryPrompts('r', TODAY, [...types]);
    expect(system).toContain('3 个维度');
    expect(system).toContain('FUNDAMENTAL、VALUATION、TECHNICAL');
    expect(user).toContain('3 个维度');
  });

  it('warns model about failed dimensions to prevent hallucinated sectionSignals', () => {
    const { system } = buildSummaryPrompts(
      'r',
      TODAY,
      ['FUNDAMENTAL', 'TECHNICAL'],
      ['INDUSTRY', 'RISK'],
    );
    expect(system).toContain('未能完成');
    expect(system).toContain('INDUSTRY');
    expect(system).toContain('RISK');
    expect(system).toContain('请勿在 sectionSignals 或正文中虚构');
  });
});

describe('primitives/buildSummaryJsonPrompts', () => {
  it('system specifies the ComprehensiveSummary JSON shape', () => {
    const { system } = buildSummaryJsonPrompts('summary md');
    expect(system).toContain('overallSignal');
    expect(system).toContain('bullCase');
    expect(system).toContain('bearCase');
    expect(system).toContain('sectionSignals');
    expect(system).toContain('watchlistWorthy');
  });

  it('system enumerates required Citation fields (sourceType + retrievedAt)', () => {
    const { system } = buildSummaryJsonPrompts('summary md');
    expect(system).toContain('sourceType');
    expect(system).toContain('retrievedAt');
    expect(system).toContain('NEWS');
    expect(system).toContain('FILING');
  });

  it('user wraps the summary markdown', () => {
    const { user } = buildSummaryJsonPrompts('SUMMARY_BODY');
    expect(user).toContain('SUMMARY_BODY');
    expect(user).toContain('请输出 ComprehensiveSummary JSON');
  });
});

describe('primitives/hydrateSummaryCitations', () => {
  // Minimal valid lenient summary skeleton; only `evidence` differs across tests.
  const baseSummary = {
    overallSignal: 'NEUTRAL' as const,
    overallConfidence: 'MEDIUM' as const,
    oneLiner: 'x',
    bullCase: ['b'],
    bearCase: ['r'],
    biggestRisk: 'risk',
    valuationConclusion: 'val',
    suitableInvestorType: 'long',
    watchlistWorthy: true,
    sectionSignals: [
      {
        type: 'FUNDAMENTAL' as const,
        signal: 'NEUTRAL' as const,
        confidence: 'MEDIUM' as const,
        oneLiner: 'x',
      },
    ],
    dataAsOf: TODAY,
    disclaimer: 'd',
  };

  const realCitation: Citation = {
    title: 'Real',
    url: 'https://example.com/a',
    sourceType: 'FILING',
    retrievedAt: '2026-05-01T12:00:00Z',
  };

  it('fills sourceType + retrievedAt from allCitations when URL matches', () => {
    const lenient = ComprehensiveSummaryLenient.parse({
      ...baseSummary,
      evidence: [
        {
          claim: 'c',
          citations: [{ title: 'Real', url: 'https://example.com/a' }],
        },
      ],
    });
    const out = hydrateSummaryCitations(lenient, [realCitation], TODAY);
    expect(out.evidence[0].citations[0]).toMatchObject({
      url: 'https://example.com/a',
      sourceType: 'FILING',
      retrievedAt: '2026-05-01T12:00:00Z',
    });
  });

  it('falls back to OTHER + dataAsOf midnight when URL is unknown', () => {
    const lenient = ComprehensiveSummaryLenient.parse({
      ...baseSummary,
      evidence: [
        {
          claim: 'c',
          citations: [{ title: 'New', url: 'https://other.example/x' }],
        },
      ],
    });
    const out = hydrateSummaryCitations(lenient, [realCitation], TODAY);
    expect(out.evidence[0].citations[0]).toMatchObject({
      sourceType: 'OTHER',
      retrievedAt: `${TODAY}T00:00:00Z`,
    });
  });

  it('preserves LLM-supplied fields when present', () => {
    const lenient = ComprehensiveSummaryLenient.parse({
      ...baseSummary,
      evidence: [
        {
          claim: 'c',
          citations: [
            {
              title: 'X',
              url: 'https://x.example/y',
              sourceType: 'NEWS',
              retrievedAt: '2026-05-20T08:00:00Z',
            },
          ],
        },
      ],
    });
    const out = hydrateSummaryCitations(lenient, [], TODAY);
    expect(out.evidence[0].citations[0]).toMatchObject({
      sourceType: 'NEWS',
      retrievedAt: '2026-05-20T08:00:00Z',
    });
  });
});

describe('primitives/buildSectionReports', () => {
  it('joins per-dimension markdown with apps/api format', () => {
    const m = new Map([
      ['FUNDAMENTAL', makeDimResult('FUNDAMENTAL', '# F report')],
      ['TECHNICAL', makeDimResult('TECHNICAL', '# T report')],
    ]);
    const out = buildSectionReports(m);
    expect(out).toContain('### FUNDAMENTAL\n# F report');
    expect(out).toContain('### TECHNICAL\n# T report');
    expect(out).toContain('\n\n---\n\n');
  });

  it('falls back to "(未完成)" when reportMarkdown is empty', () => {
    const m = new Map([['FUNDAMENTAL', makeDimResult('FUNDAMENTAL', '')]]);
    expect(buildSectionReports(m)).toContain('(未完成)');
  });
});
