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
  const assessmentRules: Record<string, string> = {
    COMPANY_QUALITY: 'STRONG、MIXED、WEAK、UNASSESSABLE',
    INDUSTRY_POSITION: 'LEADING、COMPETITIVE、CHALLENGED、UNASSESSABLE',
    VALUATION_SCENARIOS: 'UNDERVALUED、FAIR、OVERVALUED、UNASSESSABLE',
    RISK_REGISTER: 'LOW、MEDIUM、HIGH、UNASSESSABLE',
    MARKET_SIGNALS: 'POSITIVE、NEUTRAL、NEGATIVE、UNASSESSABLE',
  };
  const sectionRule = sectionType === 'VALUATION_SCENARIOS'
    ? `估值模块必须包含 methods 和 scenarios。每个 method 必须是 {"name":"...","rationale":"...","inputs":[]}；每个 scenario 必须是 {"case":"BEAR|BASE|BULL","assumptions":[],"valueRange":null,"invalidators":[]}。没有代码计算结果时，valueRange 必须是 null，不要填写 null 数字。每个数组最多保留 4 项。`
    : sectionType === 'RISK_REGISTER'
      ? `风险模块必须包含 risks 和 basedOnIncompleteSections。最多保留 6 项风险；每个 risk 必须包含 title、mechanism、likelihood、impact、indicators、invalidates、evidence，且每个数组最多 4 项。不要重复前序模块全文。`
      : '其他模块不要添加不属于本模块的字段。';
  const system = `你是结构化结果提取器。只输出纯 JSON，不要 markdown、代码块或解释文字。
结果必须符合 schemaVersion="analysis-section-v2"，且 type 必须固定为 "${sectionType}"。
顶层必须包含 schemaVersion、type、assessment、confidence、summary、findings、limitations、dataAsOf、disclaimer。
assessment 只能使用：${assessmentRules[sectionType] ?? '该模块定义的枚举'}；confidence 只能使用 HIGH、MEDIUM、LOW；数据不足时 assessment 使用 UNASSESSABLE，confidence 使用 LOW。
findings 最多 6 项，每项必须是 {"title":"...","conclusion":"...","evidence":[],"caveats":[]}。每条 evidence 最多 2 个 citation，且必须是 {"claim":"...","citations":[]}。
每个 citation 必须是对象 {"title":"...","url":"https://...","sourceType":"NEWS|FILING|RESEARCH|DATA_PROVIDER|SOCIAL|OTHER","retrievedAt":"YYYY-MM-DDTHH:mm:ss.sssZ"}，绝对不能写成 URL 字符串。citation 的 url 只能使用允许的 URL。
没有证据支持的判断不要写入 findings；没有证据时使用空数组并在 limitations 说明原因。
${sectionRule}`;
  const user = `模块：${sectionType}\n\n报告：\n${reportMarkdown}\n\n允许引用的 URL：\n${citationUrls.map((url) => `- ${url}`).join('\n')}`;
  return { system, user };
}
