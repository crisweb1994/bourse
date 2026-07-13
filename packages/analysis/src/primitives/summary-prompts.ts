import { z } from 'zod';
import { Citation } from '../contracts/citation';
import { ComprehensiveSummary } from '../contracts/comprehensive-summary';
import type { SectionType } from '../contracts/enums';
import type { DimensionRunResult } from '../dimensions/types';
import { buildCommonSuffix, DEFAULT_FRESHNESS } from '../dimensions/freshness';

const NUMBERED_SECTIONS = `1. **总体投资信号**: BULLISH / NEUTRAL / BEARISH
2. **一句话总结**
3. **主要看多理由** (3-5 条)
4. **主要看空理由** (3-5 条)
5. **最大风险**
6. **估值结论**
7. **适合什么类型投资者**
8. **是否值得加入自选观察**
9. **各维度信号汇总**`;

/**
 * Build the streaming summary prompts. System prompt is parameterized by
 * the actual available + failed dimension types, so partial-failure runs
 * don't ask the model to summarize 8 dimensions when only N succeeded
 * (codex review P2 #6).
 */
export function buildSummaryPrompts(
  sectionReports: string,
  todayDate: string,
  availableTypes: readonly SectionType[],
  failedTypes: readonly SectionType[] = [],
  question?: string,
): { system: string; user: string } {
  const count = availableTypes.length;
  const list = availableTypes.join('、');
  const failedNote =
    failedTypes.length > 0
      ? `\n\n注意：以下维度本次未能完成分析，请勿在 sectionSignals 或正文中虚构其结论：${failedTypes.join('、')}。`
      : '';
  const intro = `你是一位资深首席投资分析师。你将收到一只股票的 ${count} 个维度分析报告（${list}）。${failedNote}\n\n请基于这 ${count} 份报告生成一份综合总览：\n${NUMBERED_SECTIONS}`;
  const system = `${intro}\n${buildCommonSuffix(DEFAULT_FRESHNESS, todayDate)}`;
  const focus = question
    ? `\n\n【本次研究焦点】\n${question}\n请在综合结论中直接回答该问题，并区分事实、推断与仍不确定的信息。`
    : '';
  const user = `以下是该股票 ${count} 个维度的分析报告：\n\n${sectionReports}${focus}\n\n请生成综合投资总览报告。`;
  return { system, user };
}

// Verbatim from apps/api/src/ai/prompts/prompt.registry.ts:217-241
// COMPREHENSIVE_SUMMARY_JSON_PROMPT.
//
// `evidence[*].citations[*]` 必须包含 sourceType + retrievedAt — 之前的
// 版本只示意 `citations: [...]`，LLM 输出常缺这两字段导致 zod 校验失败、
// run 在 summary 阶段 throw（incident: 000725.SZ / 002714.SZ, 2026-05-26）。
// hydrate 路径仍会兜底，但 prompt 显式要求让一遍过的成功率提高。
const SUMMARY_JSON_SYSTEM = `你是一个数据提取专家。根据综合分析总览报告，输出 ComprehensiveSummary JSON。

输出纯 JSON，格式如下：
{
  "overallSignal": "BULLISH" | "NEUTRAL" | "BEARISH",
  "overallConfidence": "HIGH" | "MEDIUM" | "LOW",
  "oneLiner": "一句话总结",
  "bullCase": ["看多理由1", "看多理由2", ...],
  "bearCase": ["看空理由1", "看空理由2", ...],
  "biggestRisk": "最大风险描述",
  "valuationConclusion": "估值结论",
  "suitableInvestorType": "适合的投资者类型",
  "watchlistWorthy": true/false,
  "sectionSignals": [
    { "type": "FUNDAMENTAL", "signal": "...", "confidence": "...", "oneLiner": "..." },
    ...
  ],
  "evidence": [{
    "claim": "...",
    "citations": [{
      "title": "...",
      "url": "https://...",
      "sourceType": "NEWS" | "FILING" | "RESEARCH" | "DATA_PROVIDER" | "SOCIAL" | "OTHER",
      "retrievedAt": "ISO-8601 datetime, e.g. 2026-05-27T01:00:00Z"
    }]
  }],
  "dataAsOf": "YYYY-MM-DD",
  "disclaimer": "免责声明..."
}

citations 仅可使用原始 9 份维度报告中已经出现过的 URL；不要自行编造来源。
若不确定 sourceType，请选 OTHER；retrievedAt 不确定时，用 dataAsOf 当天的 00:00:00Z。
只输出 JSON，不要其他文字。`;

/**
 * Build the JSON-extraction prompts that go to provider.complete() over the
 * already-streamed summary markdown.
 */
export function buildSummaryJsonPrompts(summaryMarkdown: string): {
  system: string;
  user: string;
} {
  return {
    system: SUMMARY_JSON_SYSTEM,
    user: `以下是综合分析总览报告：\n\n${summaryMarkdown}\n\n请输出 ComprehensiveSummary JSON。`,
  };
}

// ---------------------------------------------------------------------------
// Lenient summary schema + hydrator.
//
// `ComprehensiveSummary` strictly requires `sourceType` + `retrievedAt` on
// every Citation, but LLMs reliably omit these when producing the summary
// JSON (they only see the markdown summary, not the original Citation
// records). We parse with a lenient variant, then hydrate missing fields
// from the previously-collected `allCitations` pool (matched by URL) or
// fall back to OTHER + today's date. The hydrated object is then validated
// against the strict schema before being returned to callers.
// ---------------------------------------------------------------------------

const LenientCitation = Citation.partial({
  sourceType: true,
  retrievedAt: true,
});

const LenientEvidence = z.object({
  claim: z.string().min(1),
  citations: z.array(LenientCitation),
});

/**
 * Same shape as `ComprehensiveSummary` but with relaxed citation fields.
 * Use this when parsing the LLM's summary JSON before hydration.
 */
export const ComprehensiveSummaryLenient = ComprehensiveSummary.extend({
  evidence: z.array(LenientEvidence),
});
export type ComprehensiveSummaryLenient = z.infer<
  typeof ComprehensiveSummaryLenient
>;

/**
 * Fill in missing `sourceType` / `retrievedAt` on each evidence citation.
 * Lookup priority:
 *   1. `allCitations` matched by URL (preserves real provenance)
 *   2. fallback: sourceType='OTHER', retrievedAt=`${todayDate}T00:00:00Z`
 *
 * After hydration the result is validated against the strict schema; if
 * validation still fails (e.g. URL malformed) the zod error is thrown so
 * callers see a real schema problem rather than a silent degradation.
 */
export function hydrateSummaryCitations(
  lenient: ComprehensiveSummaryLenient,
  allCitations: readonly Citation[],
  todayDate: string,
): ComprehensiveSummary {
  const byUrl = new Map<string, Citation>();
  for (const c of allCitations) {
    if (!byUrl.has(c.url)) byUrl.set(c.url, c);
  }
  const fallbackRetrievedAt = `${todayDate}T00:00:00Z`;

  const hydrated = {
    ...lenient,
    evidence: lenient.evidence.map((ev) => ({
      claim: ev.claim,
      citations: ev.citations.map((c) => {
        const match = byUrl.get(c.url);
        return {
          ...c,
          sourceType: c.sourceType ?? match?.sourceType ?? 'OTHER',
          retrievedAt:
            c.retrievedAt ?? match?.retrievedAt ?? fallbackRetrievedAt,
        };
      }),
    })),
  };

  return ComprehensiveSummary.parse(hydrated);
}

/**
 * Concatenate per-dimension reports in apps/api format
 * (`### TYPE\n${markdown}` joined by `\n\n---\n\n`). Used as the user prompt
 * payload for the summary stage.
 */
export function buildSectionReports(
  results: ReadonlyMap<string, DimensionRunResult>,
): string {
  return Array.from(results.values())
    .map((r) => `### ${r.type}\n${r.reportMarkdown || '(未完成)'}`)
    .join('\n\n---\n\n');
}
