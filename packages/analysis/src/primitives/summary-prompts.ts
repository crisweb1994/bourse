import { z } from 'zod';
import { OverallConclusion } from '../contracts/comprehensive-summary';
import { Citation, Evidence } from '../contracts/citation';
import { SectionType } from '../contracts/enums';
import type { SectionResult } from '../contracts/analysis-result';
import { DEFAULT_DISCLAIMER } from './disclaimer';

const SUMMARY_SYSTEM = `你是综合研究结论整理器，只能使用输入中已经完成的研究模块，不得搜索新资料。
请直接输出符合 OverallConclusion 结构的纯 JSON，不要输出 Markdown、代码块或解释文字。必须区分依据和反证。
如果用户提示列出必要模块缺失，signal 必须为 null；不要因此省略已完成模块的 rationale 和 counterpoints。
每个已完成模块至少提取一条有事实依据的判断；行业与竞争或市场信号缺失时，confidence 不得为 HIGH。
不要投票，不要生成买卖、仓位或收益承诺。`;

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

/**
 * Keep the user-facing summary readable when a provider ignores the first
 * pass's Markdown instruction and returns JSON instead. This is also used for
 * replaying older persisted runs that contain the raw intermediate output.
 */
export function formatSummaryMarkdown(summary: OverallConclusion): string {
  const signal = summary.signal ?? '暂无';
  const lines = [
    summary.headline,
    '',
    `**综合信号：${signal}**　**置信度：${summary.confidence}**`,
  ];

  if (summary.rationale.length > 0) {
    lines.push('', '### 支持依据');
    lines.push(...summary.rationale.map(formatEvidenceLine));
  }
  if (summary.counterpoints.length > 0) {
    lines.push('', '### 反向因素');
    lines.push(...summary.counterpoints.map(formatEvidenceLine));
  }
  if (summary.changeConditions.length > 0) {
    lines.push('', '### 需要关注的变化');
    lines.push(...summary.changeConditions.map((item) => `- ${item}`));
  }
  if (summary.missingSections.length > 0) {
    lines.push('', `数据不完整：${summary.missingSections.join('、')}`);
  }
  lines.push('', `数据截至：${summary.dataAsOf}`, '', summary.disclaimer);
  return lines.join('\n');
}

function formatEvidenceLine(evidence: Evidence): string {
  const urls = evidence.citations.map((citation) => citation.url).filter(Boolean);
  return `- ${evidence.claim}${urls.length > 0 ? `（来源：${urls.join('、')}）` : ''}`;
}

const LenientSummary = OverallConclusion.extend({
  rationale: z.array(z.object({
    claim: z.string().min(1),
    citations: z.array(Citation.partial({ sourceType: true, retrievedAt: true })),
  })),
  counterpoints: z.array(z.object({
    claim: z.string().min(1),
    citations: z.array(Citation.partial({ sourceType: true, retrievedAt: true })),
  })),
});
export type ComprehensiveSummaryLenient = z.infer<typeof LenientSummary>;
export const ComprehensiveSummaryLenient = z.preprocess(
  normalizeSummaryCandidate,
  LenientSummary,
) as unknown as z.ZodType<ComprehensiveSummaryLenient>;

/**
 * Compatible providers occasionally return the old summary vocabulary (plain
 * strings in counterpoints, objects in changeConditions, or `text` instead of
 * `claim`). Keep this adapter deliberately small: it only reshapes obvious
 * equivalents and leaves the final schema as the source of truth.
 */
function normalizeSummaryCandidate(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const raw = value as Record<string, unknown>;
  return {
    ...raw,
    headline: firstString(raw.headline, raw.oneLiner, raw.summary, raw.overallConclusion) ?? '综合结论',
    signal: normalizeSignal(raw.signal ?? raw.overallSignal),
    confidence: normalizeConfidence(raw.confidence ?? raw.overallConfidence),
    rationale: normalizeEvidenceList(
      raw.rationale ?? raw.bullCase ?? raw.supportingEvidence ?? raw.supportingPoints ?? raw.positives,
    ),
    counterpoints: normalizeEvidenceList(
      raw.counterpoints ?? raw.bearCase ?? raw.opposingEvidence ?? raw.negativePoints ?? raw.risks,
    ),
    changeConditions: normalizeStringList(
      raw.changeConditions ?? raw.watchItems ?? raw.invalidationConditions ?? raw.watchPoints,
    ),
    missingSections: Array.isArray(raw.missingSections) ? raw.missingSections : [],
    dataAsOf: firstString(raw.dataAsOf, raw.asOf) ?? new Date().toISOString().slice(0, 10),
    disclaimer: firstString(raw.disclaimer) ?? DEFAULT_DISCLAIMER,
  };
}

function normalizeEvidenceList(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      const normalized = normalizeEvidenceItem(item);
      return normalized ? [normalized] : [];
    });
  }
  if (typeof value === 'string' || (value && typeof value === 'object')) {
    const normalized = normalizeEvidenceItem(value);
    return normalized ? [normalized] : [];
  }
  return [];
}

function normalizeEvidenceItem(item: unknown): Record<string, unknown> | null {
  if (typeof item === 'string') return { claim: item, citations: [] };
  if (!item || typeof item !== 'object') return null;
  const raw = item as Record<string, unknown>;
  const claim = firstString(
    raw.claim,
    raw.text,
    raw.summary,
    raw.reason,
    raw.conclusion,
    raw.content,
    raw.description,
    raw.point,
    raw.factor,
    raw.support,
    raw.argument,
    raw.explanation,
    raw.title,
  );
  if (!claim) return null;
  return {
    claim,
    citations: normalizeCitations(raw.citations ?? raw.sources ?? raw.references ?? raw.source),
  };
}

function normalizeCitations(value: unknown): unknown[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item === 'string') return isUrl(item) ? [{ title: item, url: item }] : [];
    if (!item || typeof item !== 'object') return [];
    const raw = item as Record<string, unknown>;
    const url = firstString(raw.url, raw.href, raw.link);
    return url && isUrl(url)
      ? [{ ...raw, title: firstString(raw.title, raw.name) ?? url, url }]
      : [];
  });
}

function normalizeStringList(value: unknown): string[] {
  const values = Array.isArray(value) ? value : [value];
  return values.flatMap((item) => {
    if (typeof item === 'string' && item.trim()) return [item.trim()];
    if (!item || typeof item !== 'object') return [];
    const raw = item as Record<string, unknown>;
    const text = firstString(raw.condition, raw.trigger, raw.description, raw.text, raw.summary);
    return text ? [text] : [];
  });
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string' && value.trim().length > 0)?.trim();
}

function normalizeSignal(value: unknown): string | null {
  const upper = typeof value === 'string' ? value.toUpperCase() : '';
  if (upper === 'BULLISH' || upper === 'BULL') return 'POSITIVE';
  if (upper === 'BEARISH' || upper === 'BEAR' || upper === 'NEGATIVE') return 'CAUTIOUS';
  if (upper === 'MIXED') return 'NEUTRAL';
  return upper === 'POSITIVE' || upper === 'NEUTRAL' || upper === 'CAUTIOUS' ? upper : null;
}

function normalizeConfidence(value: unknown): string {
  const upper = typeof value === 'string' ? value.toUpperCase() : '';
  return upper === 'HIGH' || upper === 'MEDIUM' || upper === 'LOW' ? upper : 'LOW';
}

function isUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

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
