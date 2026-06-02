import type { DimensionInput, DimensionRunContext } from './types';

/**
 * MVP doc §4.3 — Plan 3 methodology prompt builders shared across the 9
 * dimensions. Each builder is a pure function so the registry validator
 * and dim factory can call them eagerly for length checks.
 */

const displayName = (input: DimensionInput): string =>
  input.name ?? input.symbol;

/**
 * §4.3.1 — cross-verification mandate (利润vs现金流 + 同业 + 熊市情景)
 * applied to all 9 dimensions' Round 2.
 */
export function crossVerificationPrompt(
  input: DimensionInput,
  ctx: DimensionRunContext,
): string {
  return `基于第一轮初步研究 ${displayName(input)}（${input.symbol}）的分析，执行以下三项强制交叉验证（${ctx.todayDate}）：

**① 利润 vs 现金流**
对比净利润趋势与经营性现金流趋势（最近 3 年至少 4 个季度）。明确标注：
- 是否同向变化？
- 是否存在背离（净利润增长但 OCF 下降，或相反）？
- 若有背离，列出 2-3 个最可能的会计/经营原因。

**② 公司 vs 同业**
列出至少 2 家可比同业，横向比较核心指标（利润率 / ROE / 估值倍数 / 增速）：
- 用 markdown 表格呈现。
- 标注本公司在每项指标上是高于/接近/低于同业中位数。
- 解释主要差距的成因（业务结构 / 周期阶段 / 治理）。

**③ 熊市情景：3-5 个触发点**
列出 3-5 个可触发悲观情景的因素，每个含：
- 触发条件（具体可观测的指标阈值或事件）
- 潜在影响幅度（对股价、利润、估值的量化估计）
- 当前距离触发的安全边际

⚠️ **必须用 web_search 寻找新证据**，不允许只引用第一轮已有引文。每项至少需要一条新引用。`;
}

/**
 * §4.3.2 — Bull / Bear / 关键辩点 论证（追加在 RISK + SCENARIO 的 Round 2）。
 */
export function bullBearAddendum(input: DimensionInput): string {
  return `

---

**追加要求（${displayName(input)}）：明确区分 Bull vs Bear 论证**

**Bull case**（至少 2 条证据）：
说明乐观假设成立的前提条件 + 支撑证据。

**Bear case**（至少 2 条证据）：
说明悲观假设成立的前提条件 + 支撑证据。

**关键辩点（Key debates）**：
列出至少 3 个分歧点。每个辩点必须分两栏：
- 双方共享的事实（双方都认可的客观数据）
- 分歧的事实（导致结论分化的关键判断）

⚠️ 禁止模棱两可表述。每个论断必须明确归到 Bull 或 Bear 一方，不允许"中性"占位。`;
}

/**
 * Generic round-2 builder: cross-verification only. Used by 6 of 8
 * existing dims (FUNDAMENTAL/VALUATION/INDUSTRY/TECHNICAL/SENTIMENT/PORTFOLIO).
 */
export const round2CrossVerifOnly = (
  input: DimensionInput,
  ctx: DimensionRunContext,
): string => crossVerificationPrompt(input, ctx);

/**
 * Round 2 for RISK + SCENARIO: cross-verification + Bull/Bear/辩点.
 */
export const round2WithBullBear = (
  input: DimensionInput,
  ctx: DimensionRunContext,
): string => crossVerificationPrompt(input, ctx) + bullBearAddendum(input);

/**
 * Round 2 for GOVERNANCE: cross-verification reframed onto governance
 * axes (ownership-vs-fundamentals, capital-allocation-vs-peer, governance
 * downside scenarios). MVP doc §4.3.5 governance row.
 */
export const round2GovernanceCrossVerif = (
  input: DimensionInput,
  ctx: DimensionRunContext,
): string =>
  `基于第一轮治理研究 ${displayName(input)}（${input.symbol}）的分析，执行三项治理专属交叉验证（${ctx.todayDate}）：

**① 股权结构 vs 业绩表现**
对比股权集中度变化（最近 3 年大股东持股比例 / 管理层持股比例 / 机构投资者比例）与 ROIC、净利润增速：
- 用 markdown 表格呈现年度数据。
- 标注是否存在"股东集中度提升 + 业绩改善"或"分散化 + 业绩恶化"等模式。
- 找出 1-2 条因股权变动直接触发的业务决策（增减资 / 战略调整 / 高管更替）。

**② 资本配置 vs 同业基准**
列出至少 2 家同业，横向对比近 5 年资本配置结构：
- 回购金额占净利润 %
- 分红占自由现金流 %
- 资本开支占收入 %
- 并购总额
- 用 markdown 表格呈现，标注本公司在每项上是高于/接近/低于同业。
- 解释差异是出于战略主动选择还是被动应对。

**③ 治理下行情景：3-5 个触发点**
列出 3-5 个治理层面可能触发悲观情景的因素：
- 控股股东减持 / 股权质押爆仓
- 关键管理层离职或诉讼
- 关联方交易 / 现金分红中断
- 监管处罚 / 财务造假传闻
每项含触发条件 + 历史先例（同行业类似事件） + 安全边际评估。

⚠️ **必须用 web search 寻找新证据**，不允许只引用第一轮已有引文。每项至少需要一条新引用。`;
