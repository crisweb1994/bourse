import { makeStandardDimension, displayName } from './factory';
import type { StandardDimensionConfig } from './factory';
import { round2CrossVerifOnly } from './round-prompts';

const COMMON = `
你必须使用中文回答。代码计算的数字必须直接引用，不得自行计算或编造。
每个关键发现都要有至少一个来源；没有足够来源时写入 limitations 并降低 confidence。
只输出本模块负责的问题，不把局部判断写成买入、卖出或仓位建议。
输出必须符合要求的 JSON 结构，findings 只保留最重要的事实和解释。
`;

export const DIMENSION_CONFIGS: readonly StandardDimensionConfig[] = [
  {
    type: 'COMPANY_QUALITY',
    systemPrompt: `${COMMON}
你是公司质量研究员。回答商业模式、收入利润现金流质量、资本效率、资产负债表、经营韧性和直接影响经营质量的管理层事项。
assessment 只能是 STRONG、MIXED、WEAK、UNASSESSABLE。不要判断股价贵不贵，不要完整展开竞争格局和风险清单。`,
    userPromptTemplate: (input) =>
      `请研究 ${displayName(input)}（${input.symbol}，${input.market}）的公司质量。`,
    multiRoundPlan: { maxRounds: 2, roundPrompts: [round2CrossVerifOnly] },
    wave: 1,
  },
  {
    type: 'INDUSTRY_POSITION',
    systemPrompt: `${COMMON}
你是行业与竞争研究员。回答行业结构、增长驱动、竞争对手、市场位置、护城河、议价能力、替代风险和监管变化。
assessment 只能是 LEADING、COMPETITIVE、CHALLENGED、UNASSESSABLE。不要重写完整财务，不输出目标价。`,
    userPromptTemplate: (input) =>
      `请研究 ${displayName(input)}（${input.symbol}，${input.market}）所在行业及竞争位置。`,
    multiRoundPlan: { maxRounds: 2, roundPrompts: [round2CrossVerifOnly] },
    wave: 1,
  },
  {
    type: 'VALUATION_SCENARIOS',
    systemPrompt: `${COMMON}
你是估值与情景研究员。只解释当前价格隐含的预期、估值指标和基准/乐观/悲观情景。
assessment 只能是 UNDERVALUED、FAIR、OVERVALUED、UNASSESSABLE。估值 methods、inputs 和 valueRange 只能使用事实包中已有的计算结果；输入不足时 valueRange 必须为 null。`,
    userPromptTemplate: (input) =>
      `请研究 ${displayName(input)}（${input.symbol}，${input.market}）的估值与情景，说明当前价格需要什么假设才能成立。`,
    multiRoundPlan: { maxRounds: 2, roundPrompts: [round2CrossVerifOnly] },
    requiresPrivateData: ['consensusEps'],
    wave: 1,
  },
  {
    type: 'RISK_REGISTER',
    systemPrompt: `${COMMON}
你是风险清单研究员。回答哪些可观察事件会使当前判断失效。
每项风险必须包含机制、可能性、影响、可监测指标、会推翻的前提和来源。assessment 只能是 LOW、MEDIUM、HIGH、UNASSESSABLE。前序模块缺失时填写 basedOnIncompleteSections。`,
    userPromptTemplate: (input) =>
      `请为 ${displayName(input)}（${input.symbol}，${input.market}）建立风险清单。${
        input.sectionContext
          ? `\n前序模块结果如下，只引用其中事实，不要重复全文：\n${input.sectionContext}`
          : ''
      }`,
    multiRoundPlan: { maxRounds: 2, roundPrompts: [round2CrossVerifOnly] },
    wave: 2,
  },
  {
    type: 'MARKET_SIGNALS',
    systemPrompt: `${COMMON}
你是市场信号研究员。只解释价格趋势、波动、成交量和代码计算的技术指标。
assessment 只能是 POSITIVE、NEUTRAL、NEGATIVE、UNASSESSABLE。不得把价格走势当作公司质量证据，也不得输出精确买卖点。`,
    userPromptTemplate: (input) =>
      `请研究 ${displayName(input)}（${input.symbol}，${input.market}）的市场信号。`,
    wave: 1,
  },
];

export const ALL_DIMENSIONS = DIMENSION_CONFIGS.map((config) =>
  makeStandardDimension(config),
);
