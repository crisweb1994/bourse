import type { Citation } from '../contracts/citation';
import type { SectionType } from '../contracts/enums';
import { JudgeResult } from '../contracts/judge-result';
import type { Dimension } from '../dimensions/types';
import { judgeNeutral } from '../personas/judge-neutral';
import type { Persona } from '../personas/types';
import { computeUsd } from './pricing';
import type { AgentProvider } from './provider';
import { structuredOutputWithRepair } from './structured-output';

/**
 * RFC-10 P1 — pure trigger function: should the COMPREHENSIVE workflow's
 * selective-judge phase audit this dim?
 *
 * Combines `dimension.judgeRequired` (default `'on-strong'`) with three
 * global escalation rules. Any single trigger flips it on:
 *
 *   1. `dimension.judgeRequired === 'always'` — pinned at registration
 *   2. `on-strong` + structuredJson conclusion is HIGH + BULLISH/BEARISH
 *      (the "strong claim" axis — neutral outputs are skipped even at HIGH)
 *   3. Citation Tier D/E share > `tierDeThreshold` (default 0.5):
 *      tier D/E sources are weak (forums, blogs, scraped pages); a strong
 *      claim resting mostly on them deserves an audit
 *   4. cross-dim validator surfaced a WARNING or DOWNGRADE on this dim
 *
 * `'never'` short-circuits everything — used for low-stakes dims where
 * audit cost outweighs benefit (TECHNICAL / SENTIMENT).
 *
 * P2 will add `runJudge(provider, input, options)` that consumes the
 * trigger output. P1 just ships the schema + this pure function so other
 * code can already type against it.
 */

export interface JudgeTriggerContext {
  dimension: Pick<Dimension, 'judgeRequired'>;
  structuredJson: {
    conclusion?: {
      signal?: string;
      confidence?: string;
    };
  };
  /** Citations the dim emitted. Only `qualityTier` is read. */
  citations: ReadonlyArray<Pick<Citation, 'qualityTier'>>;
  /** Highest severity the cross-dim validator attached to this dim, if any. */
  crossDimSeverity?: 'WARNING' | 'DOWNGRADE' | 'FAIL';
  /** Override the default Tier D/E threshold (0.5 = >50%). */
  tierDeThreshold?: number;
}

const DEFAULT_TIER_DE_THRESHOLD = 0.5;
const STRONG_SIGNALS = new Set(['BULLISH', 'BEARISH']);
const WEAK_TIERS = new Set(['D', 'E']);

export function shouldJudge(ctx: JudgeTriggerContext): boolean {
  const req = ctx.dimension.judgeRequired ?? 'on-strong';
  if (req === 'never') return false;
  if (req === 'always') return true;

  // 'on-strong' branch — any of the escalation rules below trips it.
  const conclusion = ctx.structuredJson.conclusion ?? {};
  if (
    conclusion.confidence === 'HIGH' &&
    typeof conclusion.signal === 'string' &&
    STRONG_SIGNALS.has(conclusion.signal)
  ) {
    return true;
  }

  if (ctx.citations.length > 0) {
    const threshold = ctx.tierDeThreshold ?? DEFAULT_TIER_DE_THRESHOLD;
    const weak = ctx.citations.filter(
      (c) => typeof c.qualityTier === 'string' && WEAK_TIERS.has(c.qualityTier),
    ).length;
    if (weak / ctx.citations.length > threshold) return true;
  }

  if (
    ctx.crossDimSeverity === 'WARNING' ||
    ctx.crossDimSeverity === 'DOWNGRADE'
  ) {
    return true;
  }

  return false;
}

// ===== RFC-10 P2: runJudge primitive =====

export interface RunJudgeInput {
  /** Which dim is under audit (used in prompt + telemetry tag). */
  dimensionType: SectionType;
  /**
   * Pre-serialized EvidencePack block (markdown). Caller chooses the
   * format — typically `formatEvidencePackBlock(v2Pack)` for CN, or the
   * v1 debate-style formatter for other markets. Judge never touches the
   * raw EvidencePack object; isolating serialization here keeps the
   * primitive independent of v1/v2 schema choices.
   */
  evidencePackText: string;
  /** The dim's structuredJson output. JSON-stringified into prompt. */
  structuredJson: unknown;
  /** Dim's report markdown — truncated to MAX_REPORT_CHARS in prompt. */
  reportMarkdown: string;
  /** Citations the dim emitted; tier info shown to judge so it can call
   *  out weak-source-supported strong claims. */
  citations: ReadonlyArray<Citation>;
  /** Cross-dim validator severity attached to this dim (if any). */
  crossDimSeverity?: 'WARNING' | 'DOWNGRADE' | 'FAIL';
}

export interface RunJudgeOptions {
  signal?: AbortSignal;
  /** Override the default judge persona (judgeNeutral). */
  judge?: Persona;
}

export interface RunJudgeOutput {
  result: JudgeResult;
  trace: {
    tokensIn: number;
    tokensOut: number;
    /** USD computed from `computeUsd(model, tokensIn, tokensOut)`. */
    costUsd: number;
    durationMs: number;
    /** 1 normally, 2 if the structured-output repair pass ran. */
    llmCalls: number;
    /** Model id billed for the final attempt. */
    model?: string;
  };
}

const MAX_REPORT_CHARS = 4000;

/**
 * RFC-10 P2 — run the selective judge audit against one dim's output.
 *
 * The judge:
 *   - reads ONLY EvidencePack + structuredJson + report excerpt + citations
 *   - emits `JudgeResult` (concerns / suggestedRevisions / confidence
 *     adjustment) via structured-output-with-repair (one repair pass max)
 *   - never calls web_search or any explicit tool — uses `provider.complete`
 *     which is by construction a no-tool path
 *
 * Workflow code (P3) decides what to do with the output: log concerns,
 * apply confidenceAdjustment to dim.structuredJson.conclusion.confidence,
 * forward via SSE. The primitive itself is side-effect free.
 */
export async function runJudge(
  provider: AgentProvider,
  input: RunJudgeInput,
  options: RunJudgeOptions = {},
): Promise<RunJudgeOutput> {
  const startedAt = Date.now();
  const judge = options.judge ?? judgeNeutral;
  const systemPrompt = buildJudgeSystemPrompt(judge);
  const userPrompt = buildJudgeUserPrompt(input);

  const out = await structuredOutputWithRepair(
    provider,
    systemPrompt,
    userPrompt,
    JudgeResult,
    options.signal ? { signal: options.signal } : {},
  );

  const tokensIn = out.usage.tokensIn ?? 0;
  const tokensOut = out.usage.tokensOut ?? 0;
  const costUsd = computeUsd(out.model, tokensIn, tokensOut);

  return {
    result: out.data,
    trace: {
      tokensIn,
      tokensOut,
      costUsd,
      durationMs: Date.now() - startedAt,
      llmCalls: out.llmCalls,
      ...(out.model ? { model: out.model } : {}),
    },
  };
}

function buildJudgeSystemPrompt(judge: Persona): string {
  return `${judge.styleDescription}

【RFC-10 单维审计任务】
你不是在重新分析这个维度，也不是在加一轮辩论。任务是**审计**一个已经完成的维度输出（structuredJson + report），针对以下要点给出结构化反馈：

1. **结论支撑度**：structuredJson.conclusion 的 signal/confidence 是否被 EvidencePack 内的事实直接支持？是否依赖了 EvidencePack 之外的推断？
2. **引用质量**：报告引用的 URL 是否在 allowedUrls 内？引用来源的 tier（A=官方/交易所、B=主流财经媒体、C=研究机构、D=博客论坛、E=社交）分布是否与结论强度匹配？强 BULLISH/BEARISH + 多 Tier D/E 是危险信号。
3. **盲点**：EvidencePack 中存在但报告未引用的关键事实
4. **跨维度矛盾**：若 caller 标了 cross-dim WARNING/DOWNGRADE，必须在 concerns 里直接引用并解释

【输出格式硬约束】
只输出 JSON 对象，不要任何前后缀、不要 markdown 代码块。schema：

{
  "schemaVersion": "judge-result-v1",
  "pass": true | false,
  "concerns": [<具体问题描述，每条引用 EvidencePack 字段或 structuredJson 字段>],
  "suggestedRevisions": [<建议改动，可空>],
  "confidenceAdjustment": "KEEP" | "DOWNGRADE_TO_MEDIUM" | "DOWNGRADE_TO_LOW"
}

⚠️ 约束：
- concerns 最多 8 条；suggestedRevisions 最多 5 条
- confidenceAdjustment **只能 KEEP 或下调**，禁止上调（即使你认为 dim 信心过低）
- pass=false 时 concerns 必须非空
- 不允许调用 web_search 或引入 EvidencePack 之外的资料
- 不允许重写报告内容，只标问题`;
}

function buildJudgeUserPrompt(input: RunJudgeInput): string {
  const reportExcerpt =
    input.reportMarkdown.length > MAX_REPORT_CHARS
      ? `${input.reportMarkdown.slice(0, MAX_REPORT_CHARS)}\n\n[...截断，原文 ${input.reportMarkdown.length} 字]`
      : input.reportMarkdown;

  const citationLines = input.citations.length === 0
    ? '（无引用）'
    : input.citations
        .map(
          (c, i) =>
            `${i + 1}. [tier=${c.qualityTier ?? '?'}] ${c.title}\n   ${c.url}`,
        )
        .join('\n');

  const crossDimNote = input.crossDimSeverity
    ? `\n\n【cross-dim validator 严重度】${input.crossDimSeverity}（caller 已检测到跨维度冲突；必须在 concerns 中提及）`
    : '';

  return `审计目标维度：**${input.dimensionType}**

【EvidencePack（不可变事实）】
${input.evidencePackText}

【该维度 structuredJson】
${JSON.stringify(input.structuredJson, null, 2)}

【该维度报告摘录】
${reportExcerpt}

【该维度引用列表（${input.citations.length} 条）】
${citationLines}${crossDimNote}

请按 system 中的 schema 输出 JSON 审计结果。`;
}
