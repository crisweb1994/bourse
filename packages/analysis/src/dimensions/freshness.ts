import type { FreshnessPolicy } from './types';

/**
 * Default freshness for walking-skeleton dimensions. Mirrors the constant
 * `FRESHNESS_BLOCK` in apps/api/src/ai/prompts/prompt.registry.ts so that
 * Day 11 parity tests produce identical prompt text per dimension.
 */
export const DEFAULT_FRESHNESS: FreshnessPolicy = {
  pricesMaxAgeDays: 7,
  newsMaxAgeDays: 30,
  financialsRequirement: '使用最近一份已公布的季报或年报',
  staleDataWarningThreshold: '6 个月前或更早',
};

/**
 * Render the data-freshness preamble.
 *
 * `webSearchAvailable` defaults to true to preserve byte-equivalence with
 * apps/api parity tests. When false (chat.completions provider without a
 * pluggable executor wired), we swap in a "no tool" variant that tells
 * the model to use only context facts + training knowledge and forbids
 * emitting any pseudo tool-call syntax — see HallucinationFilter for the
 * defense-in-depth strip on the stream side.
 */
export function buildFreshnessBlock(
  policy: FreshnessPolicy,
  todayDate: string,
  webSearchAvailable = true,
): string {
  if (!webSearchAvailable) {
    return `
## 数据时效（最高优先级，必须严格遵守）
- 今日日期：${todayDate}（动态注入；以下所有"最新"均以此为基准）
- **本次运行无 web_search 工具可用**。仅基于 prompt 中提供的事实包/上下文 + 你的训练知识进行分析；任何无法核实的具体数字必须写"数据缺失"或"无数据"
- **严禁**在输出中包含以下伪工具调用语法：\`<function>\`、\`<invoke>\`、\`<function_calls>\`、\`web_search(...)\`、\`{thoughts:..., command:...}\`、"搜索 1: ..." 等检索计划或工具调用占位文本
- 若你认为缺数据，直接用一句中文陈述"数据缺失"，不要写检索过程
- 财务数据：${policy.financialsRequirement}；每个数据点必须标注「数据日期：YYYY-MM-DD」
- 引用必须来自上下文 / 事实包中已提供的真实 URL，禁止编造链接
- 数字的内部一致性必须自查（如净利润不可大于收入；EPS × 流通股数 ≈ 净利润）
`;
  }
  return `
## 数据时效（最高优先级，必须严格遵守）
- 今日日期：${todayDate}（动态注入；以下所有"最新"均以此为基准）
- 你必须使用 web_search 工具检索数据，**严禁基于训练记忆给出任何具体数字**
- 财务数据：${policy.financialsRequirement}；每个数据点必须标注「数据日期：YYYY-MM-DD」
- 股价/技术指标：必须使用最近 ${policy.pricesMaxAgeDays} 天内的报价
- 新闻/动态：必须使用最近 ${policy.newsMaxAgeDays} 天内的报道
- 如果搜索仅能返回 ${policy.staleDataWarningThreshold}的数据，请在报告**开头**写明「⚠️ 数据陈旧告警：最新可用数据为 YYYY-MM，可能不反映当前情况」，再继续基于这些数据分析
- 引用必须来自真实可访问的 URL，禁止编造链接
- 数字的内部一致性必须自查（如净利润不可大于收入；EPS × 流通股数 ≈ 净利润）
`;
}

/**
 * Suffix appended to every dimension's system prompt. Same layout as
 * apps/api COMMON_SUFFIX. Disclaimer text is enforced here — LLM must NOT
 * override it (CLAUDE.md §4 #21).
 */
export function buildCommonSuffix(
  policy: FreshnessPolicy,
  todayDate: string,
  webSearchAvailable = true,
): string {
  return `
${buildFreshnessBlock(policy, todayDate, webSearchAvailable)}

## 输出要求
- 使用中文撰写报告
- 每个核心判断必须附带引用来源 URL
- 明确标注"数据截至日期"
- 结尾声明"免责声明：本报告由 AI 生成，不构成投资建议。投资有风险，入市需谨慎。"
- 数据缺失时诚实报告，不编造数据
`;
}
