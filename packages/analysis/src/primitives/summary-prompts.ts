import { z } from 'zod';
import { OverallConclusion } from '../contracts/comprehensive-summary';
import { Citation, Evidence } from '../contracts/citation';
import { SectionType } from '../contracts/enums';
import type { SectionResult } from '../contracts/analysis-result';

const SUMMARY_SYSTEM = `你是综合研究结论整理器，只能使用输入中已经完成的五个研究模块，不得搜索新资料。
输出中文，必须区分依据和反证。公司质量、估值与情景、风险清单三者只要有一个缺失或 assessment=UNASSESSABLE，signal 必须为 null。
行业与竞争或市场信号缺失时，仍可形成结论但 confidence 不得为 HIGH。
不要投票，不要生成买卖、仓位或收益承诺。只输出符合 OverallConclusion 结构的 JSON。`;

export function buildSummaryPrompts(
  sectionReports: string,
  todayDate: string,
  availableTypes: readonly SectionType[],
  failedTypes: readonly SectionType[],
  question?: string,
  missingRequiredTypes: readonly SectionType[] = [],
): { system: string; user: string } {
  const missing = failedTypes.length > 0
    ? `\n未能完成模块：${failedTypes.join('、')}。不得虚构这些模块的结果。`
    : '';
  const gate = missingRequiredTypes.length > 0
    ? `\n必要模块缺失：${missingRequiredTypes.join('、')}，signal 必须为 null。`
    : '';
  const focus = question ? `\n用户重点问题：${question}` : '';
  return {
    system: `${SUMMARY_SYSTEM}\n数据日期参考：${todayDate}${missing}${gate}`,
    user: `已完成模块（${availableTypes.join('、')}）：\n${sectionReports}${focus}\n\n请生成综合结论，不要重新搜索。`,
  };
}

export function buildSummaryJsonPrompts(summaryMarkdown: string) {
  return {
    system: `${SUMMARY_SYSTEM}
请把下面的总结转换为严格 JSON。必须包含 headline、signal、confidence、rationale、counterpoints、changeConditions、missingSections、dataAsOf、disclaimer。rationale 和 counterpoints 中的每条证据必须包含 claim，以及带有 title、url、sourceType、retrievedAt 的 citations。signal 只能是 POSITIVE、NEUTRAL、CAUTIOUS 或 null。证据只能使用总结中出现的来源。`,
    user: `请输出 ComprehensiveSummary JSON：

${summaryMarkdown}`,
  };
}

export const ComprehensiveSummaryLenient = OverallConclusion.extend({
  rationale: z.array(z.object({
    claim: z.string().min(1),
    citations: z.array(Citation.partial({ sourceType: true, retrievedAt: true })),
  })),
  counterpoints: z.array(z.object({
    claim: z.string().min(1),
    citations: z.array(Citation.partial({ sourceType: true, retrievedAt: true })),
  })),
});
export type ComprehensiveSummaryLenient = z.infer<typeof ComprehensiveSummaryLenient>;

export function hydrateSummaryCitations(
  summary: ComprehensiveSummaryLenient,
  allCitations: readonly Citation[],
  todayDate: string,
): z.infer<typeof OverallConclusion> {
  const byUrl = new Map(allCitations.map((citation) => [citation.url, citation]));
  const fallback = `${todayDate}T00:00:00.000Z`;
  const hydrate = (evidence: Array<{ claim: string; citations: Array<Partial<Citation> & { title: string; url: string }> }>): Evidence[] =>
    evidence.map((item) => ({
      claim: item.claim,
      citations: item.citations.map((citation) => {
        const known = byUrl.get(citation.url);
        return {
          ...citation,
          sourceType: citation.sourceType ?? known?.sourceType ?? 'OTHER',
          retrievedAt: citation.retrievedAt ?? known?.retrievedAt ?? fallback,
        } as Citation;
      }),
    }));
  return OverallConclusion.parse({
    ...summary,
    rationale: hydrate(summary.rationale),
    counterpoints: hydrate(summary.counterpoints),
  });
}

export function buildSectionReports(
  results: ReadonlyMap<SectionType, { reportMarkdown: string }>,
): string {
  return Array.from(results.entries())
    .map(([type, result]) => `### ${type}\n${result.reportMarkdown || '（模块未完成）'}`)
    .join('\n\n---\n\n');
}

export function normalizeSummarySignal(
  summary: z.infer<typeof OverallConclusion>,
  requiredMissing: readonly SectionType[],
): z.infer<typeof OverallConclusion> {
  if (requiredMissing.length === 0) return summary;
  return { ...summary, signal: null, confidence: 'LOW' };
}
