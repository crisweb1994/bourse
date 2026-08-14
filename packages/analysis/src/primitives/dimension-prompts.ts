import type { SectionType } from '../contracts/enums';
import type { EvidencePackV2 } from '../contracts/evidence-pack-v2';

export function formatEvidencePackBlock(
  pack: EvidencePackV2,
  sectionType?: SectionType,
): string {
  const coverage = sectionType
    ? pack.researchCoverage?.dimensions[sectionType]
    : undefined;
  const lines = ['【代码核验事实】以下事实来自本次不可变快照，优先使用，不要重新计算：'];
  for (const [key, fact] of Object.entries(pack.facts ?? {})) {
    if (!fact) continue;
    const value = JSON.stringify(fact.value);
    lines.push(
      `- ${key}: ${value.length > 2_000 ? `${value.slice(0, 2_000)}…` : value}` +
        `（数据日期：${fact.asOf}；来源：${fact.sourceUrl}）`,
    );
  }
  if (pack.computedFacts) {
    lines.push(
      '【代码计算指标】以下比率、技术指标、风险旗标和估值辅助结果由代码计算，只能解读，不能重新计算：',
      JSON.stringify(pack.computedFacts, null, 2).slice(0, 24_000),
    );
  }
  if (pack.dataAvailability.missing.length > 0) {
    lines.push(
      '【数据缺失】',
      pack.dataAvailability.missing
        .map((item) => `- ${item.field}: ${item.reason}`)
        .join('\n'),
    );
  }
  if (coverage) {
    lines.push(`\n【本模块数据状态】${coverage.status}`);
    if (coverage.missingCriticalFacts.length > 0) {
      lines.push(`缺失：${coverage.missingCriticalFacts.join('、')}`);
    }
    if (coverage.blockedClaims.length > 0) {
      lines.push(`禁止声称：${coverage.blockedClaims.join('、')}`);
    }
  }
  lines.push(
    '\n数字事实必须直接引用；数据缺失时明确写限制，不得凭常识补齐。网页搜索只能补充未覆盖的定性背景，不能覆盖代码核验数字。',
  );
  return lines.join('\n');
}

export function buildStructuredOutputPrompts(
  sectionType: string,
  reportMarkdown: string,
  citationUrls: string[],
): { system: string; user: string } {
  const system = `你是结构化结果提取器。只输出纯 JSON，不要 markdown 或解释文字。
结果必须包含 schemaVersion="analysis-section-v2"、type="${sectionType}"、assessment、confidence、summary、findings、limitations、dataAsOf、disclaimer。
findings 每项包含 title、conclusion、evidence、caveats；evidence 的 citation 只能使用允许的 URL。没有证据的判断不要写入 findings。
估值模块必须包含 methods 和 scenarios；风险模块必须包含 risks 和 basedOnIncompleteSections；其他模块不添加不存在的数字。
assessment 必须使用该模块允许的枚举值，数据不足时使用 UNASSESSABLE。`;
  const user = `模块：${sectionType}\n\n报告：\n${reportMarkdown}\n\n允许引用的 URL：\n${citationUrls.map((url) => `- ${url}`).join('\n')}`;
  return { system, user };
}
