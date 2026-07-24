# 产品方向 + 待办功能池

> 本文档合并了产品需求（PRD）和功能 backlog。
> 技术参考 → `docs/ARCHITECTURE.md`；产品演进分析 → `docs/product-evolution.md`；Chat RFC → `docs/chat-rfc.md`。
> 讨论功能时，未做的待选项按模块登记在此；新功能方向进 §产品演进 讨论后再登记。

---

## 产品定位（v1.1）

**Bourse 是一个全球股票研究助手**，帮助个人投资者在"研究 → 决策 → 跟踪 → 复盘"全周期获得专业级辅助。

核心价值主张：零数据仓库、9 维度深度分析、代码计算保证数字准确、强制引用可验证、全球市场覆盖（US / HK / CN / JP / UK）。

### v1.1 要解决的核心问题

| # | 问题 | 用户感受 |
|---|---|---|
| 1 | 数字不准 | "财报数据和 Yahoo 对不上" |
| 2 | 缺时间感 | "本周财报你怎么没提" |
| 3 | 孤立报告 | "我自选股 30 只，没有一个总览" |
| 4 | 不可追溯 | "你上个月让我买的，现在跌了" |
| 5 | 一次性体验 | 报告生成完就结束，无法追问 |

### v1.1 六大模块

| 模块 | 内容 | 阶段 |
|---|---|---|
| 1. 单股深度分析 | v1.0 加固：数字准确度、数据时点透明 | v1.1-α |
| 2. 可信数据与证据 | 数字来源标注、引用内容验证、降级提示 | v1.1-α |
| 3. 时间与事件感知 | 事件日历（财报/股息/解禁）、宏观事件影响 | v1.1-β |
| 4. 关联与组合视角 | 同行对照、与自选股相关性、自选股聚合面板 | v1.1-β |
| 5. 历史追溯与自我校准 | 分析时间线、Diff 视图、置信度校准面板 | v1.1-α→GA |
| 6. 持续跟踪 | 追问（动态推荐问题）、挑战 evidence、告警 | v1.1-GA |

### 不在 v1.1 范围（明确边界）

加密货币 / 商品 / 外汇、毫秒级实时行情、App 推送 / 移动客户端、多 agent 辩论、投资 Persona、自动交易、量化回测、社区 UGC。

---

## AI Provider 抽象（用户自配模型）

> Phase 1（明文落库 `AiProviderSetting` + CRUD + test + models 拉取 + Settings 页 + 分析入口下拉 + 按任务路由 Primary/Utility）已落地，详见 ARCHITECTURE.md §5.3。

### Phase 2 — 推迟

- **重新启用 apiKey 加密（多租户/SaaS 场景）**
  - 价值：当本应用部署为多租户 SaaS、或合规要求 DB 备份不含明文凭证时，需要 at-rest 加密。
  - 触发：上线 SaaS / 合规审计 / DB 备份外发场景。
  - 注意：必须配套设计 key 轮换流程（双 key 解密 + 异步重加密），否则会重蹈"AES_SETTINGS_ENCRYPTION_KEY 不可轮换"的体验坑。

- **Direct Connections（高隐私模式）**
  - 价值：API Key 只存浏览器，请求时作为 header 透传，服务端不落库，适合隐私敏感用户。
  - 触发：有用户明确反馈不愿意 key 入库 / 出现合规要求。

- **多 Key Fan-out（轮询 / 随机）**
  - 价值：一个 provider 配置多个 Key，自动轮换绕限流。
  - 触发：用户反馈被限流 / 单 Key 配额不够。

- **使用量统计 & 成本估算**
  - 价值：按 provider / model 维度统计 token 消耗、估算费用，避免账单意外。
  - 触发：有用户烧 key 烧出问题、或推出付费版前必备。
  - 注意：v1 只记 token 数不记 USD；这条做的时候要重新引入价格表。

- **每日 LLM 费用上限与预算预占**
  - 状态：2026-07-24 从财报速读和投关记录当前实现移除；开源单实例版本暂不需要数据库锁、费用预占、结算和过期回收。
  - 价值：自动轮询大量公告时限制每日模型 API 支出，避免自托管用户意外消耗过多额度。
  - 触发：出现真实用户的意外账单反馈，或自动任务规模明显增长。
  - 实现边界：优先做一个全局可选上限和调用前累计检查，不恢复分模块预算、并发预占或多节点租约。

- **模型能力自动探测**
  - 价值：替代手动勾选 `supportsWebSearch / supportsTools`，调用一次探测请求自动推断。
  - 触发：用户反馈手动配置易错。

- **Azure / Bedrock 专属适配**
  - 价值：覆盖企业用户（Azure 需要 deployment 路由 + apiVersion，Bedrock 需要 SigV4）。
  - 触发：有企业客户需求。

- **Provider 配置导入 / 导出（JSON）**
  - 价值：跨设备 / 团队内分享配置。**注意 LobeChat 的明文 URL 分享是坑** —— 导出前必须强制脱敏 Key。
  - 触发：多设备用户增多。

- **请求日志查看器**
  - 价值：在 Settings 里看最近 N 次 provider 调用的请求/响应/耗时，便于调试。
  - 触发：用户反馈某 provider 返回异常无从排查。

- **OpenAI Responses API 路由**
  - 价值：新一代 reasoning 模型（o 系列）只走 `/v1/responses`，需维护一个 `useResponseModels` 名单按模型路由。
  - 触发：用户配置 OpenAI o 系列模型时报错。

- **结构化输出回退策略**
  - 价值：tools-calling 不可靠的 provider 自动回退到 JSON-mode prompting（LobeChat `useToolsCalling: false` 模式）。
  - 触发：DeepSeek/Qwen/Kimi 用户反馈 structured JSON 失败率高。

---

## Analysis 模块

### 竞品吸收候选（2026-07-19 登记，来源：review ZhuLinsen/daily_stock_analysis）

- **结论结果回看（signal outcome tracking）**：每次分析持久化可校验的操作性结论（方向 + 锚定价），T+1/3/5/10 日用行情数据计算 hit/miss/neutral，聚合成命中率统计展示。全程 compute 层计算，符合"代码计算"不变式；是建立用户信任的强抓手。该 repo 的 `decision_signal_outcome_service` 是参考实现（含 unable 原因枚举 + 可重试语义）。
- **Connector 优先级链 + 熔断**：数据源按 priority 排序 + 每源 CircuitBreaker（失败 N 次进 cooldown），健康状态可查询。Bourse connector 层目前无熔断；免费源不稳时可借鉴。
- **交易时段感知（market phase）**：报告按 盘前/盘中/盘后/非交易日 标注数据完整性语义（当日 K 线是否收完整），避免盘中数据被当成日线结论。可作为 snapshot 元数据 + prompt 注入的小改进。
- **Digest 推送格式参考**：其「决策仪表盘」推送结构（一句话结论 + 信号灯 + 分仓建议 + 检查清单）在 IM 卡片里信息密度高，Daily Brief Phase A 排版可参考（但不抄具体买卖点位建议，合规红线）。

### 竞品吸收候选（2026-07-19 二轮登记，来源：全景竞品 web 调研）

- **财报 / 电话会解读**（fiscal.ai Earnings Hub、蚂小财 5 秒财报解读、Perplexity 实时 transcript + 要点提取）→ 已展开为 PRD：`docs/earnings-prd.md`（2026-07-19）：海外/国内头部产品的共同重心，Bourse 9 维里 FUNDAMENTAL 只有 ratio 层，财报事件驱动的"这季度发生了什么、管理层怎么说"是空白。可作为独立 dimension 或 chat 工具切入。
- **自然语言 Screener**（Perplexity Finance、同花顺问财的核心心智）："帮我找 XX 条件的股票"是问股场景的自然延伸；Bourse 明确 v1.1 不做，但 chat 落地后用户必然会问，需要至少有礼貌降级话术 + backlog 定位。
- **Watchlist 简报 / 组合层视角**（Perplexity watchlist briefings、Robinhood Portfolio Digests）：Daily Brief 已定档自选股聚合，竞品验证了"组合层 AI 摘要"（而非逐股）是留存抓手，Phase B 优先级可上调。
- **可解释评分卡**（Danelfin 1-10 分 + 三维子分 + 归因指标；TipRanks Smart Score）：Bourse 有 9 维结论但无顶层量化锚点。若做，评分必须 compute 层可复现（如 checklist 通过率），不能让 LLM 拍分数——与"代码计算"不变式一致。
- **准确率公开追踪**（Danelfin 公布 alpha 曲线、TipRanks 追踪每个分析师历史命中率）：与一轮登记的 signal outcome tracking 同源，竞品证明"敢公布准确率"本身就是营销资产。

- **快速 / 深度 preset**
  - 价值：综合分析 9 维 + summary 耗时较长，有用户只想要 60s 内拿到主要结论。
  - 设计方向：preset 映射到 dimensions 子集 + token budget（快速 = 砍 SOCIAL/SCENARIO，深度 = 全量 + LLM utility 走 primary 同档）
  - 触发：用户反馈"等太久"密度增加时。

- **时间窗 / period 输入**
  - 价值：现在分析按 dimension default freshness（多数 90d）；用户想问"过去 3 年"或"最近 30 天"无法表达。
  - 触发：财报季 / 长期跟踪场景请求出现时。

---

## 财报速读 / 投关记录：开源版复杂度约束

> 2026-07-24 二次审计结论：优先保持单实例、自托管可理解性；不以多副本、SaaS 计费或大规模吞吐作为默认前提。简化不能牺牲数字语义、原文引用和修订追溯。

### 2026-07-24 已完成

- **已删除 `EarningsMetricFactProjection` 持久化投影**：趋势数据直接从各期 current revision 的 `payload.facts` 读取，查询时做兼容性筛选、YTD 差分和 YoY/QoQ；同步投影、回填脚本和 `isCurrent` 维护已移除。
- **投关记录改为懒生成**：股票页首次打开时生成，失败可显式重试；独立 `InvestorRelationsDetectionScheduler` 和第二套 DetectionCursor 已删除。
- **财报和共识调度改为单实例模型**：保留 `running` 防重入、固定保守并发和失败退避；多副本 advisory lock、DB lease/续租和 scheduler claim 已删除。
- **配置项已收敛为零**：财报、港股、趋势和投关默认可用；检测周期、共识周期、最大快照年龄、抽取超时、批次和并发均为代码内保守常量，不再暴露财报/投关环境变量。
- **每日预算体系已删除**：财报/投关不再维护预算预占、结算、释放和过期回收；只记录实际 token/cost。

### 必须保留

- `MetricFact` 的期间、累计口径、合并范围、会计准则、币种/单位和 `sourceSpan`。
- `Filing` 原文不可变、内容哈希去重、`FilingDerivation` 按 parser/model 版本可重跑。
- Earnings/IR revision 历史、current pointer、事务写入、幂等键和 correction/supplement 关系。
- 事件/修订写入的并发保护。即使单实例，同一进程内的并发请求也可能产生重复 revision；这类锁属于正确性保护，不按“企业级冗余”删除。
- 港股双语来源归组与按需抓取；可以懒加载，不能丢失来源关系。

### 本轮同时修正

- 投关 revision 在获取事件锁后重新读取 `currentRevisionId`，不再使用事务外旧快照。
- 投关跨来源归并只接受相同内容哈希或 `sourceGroupId`；通用标题不再触发合并，`DUPLICATE_SOURCE` 已删除。
- Chat 只有在投关卡片传入明确 eventId 时进入 IR 模式，自然语言不再抢占财报问题。
- 趋势先在完整兼容序列中查找 YoY/QoQ 基期，再截取用户要求展示的 4/8/12 个点。

---

## Daily Brief / 行情简报（定时推送）

> 专项 PRD 已归 git 历史（v1.5 定稿）。
> 承接场景：被动收消息 / 关键事件告警 / 自动复研建议 / 自选股聚合面板。

- **价值**：用户不打开 App 也能收到盘前 / 盘后的两段式行情简报（大盘指数 + 自选股，AI 解读 + 异动深入），主动推送到 IM（飞书 / Telegram / Slack / 钉钉 / 企微 / 通用 Webhook）。是 Bourse 第一根「时间驱动 + 主动触达」的能力。
- **已定档（v1.5）**：模式 C heartbeat 调度（`market-hours.ts` 判窗口，DST 解耦）；AI 标配走用户 `AiProviderSetting`（Utility，未配降级纯数字）；完整简报只在 IM（不新增 App 页、不落库）；单向推送 + 按钮跳转（无双向回调）；ChannelAdapter 抽象；异动 + 大盘优先截断；实时推送不勿扰。
- **Phase A 范围**：heartbeat 调度 + 指数数据层（首要风险：`^GSPC` 可拉性验证）+ Market Overview / 自选 compute+AI + 通用 Webhook / 飞书 / Telegram adapter + DigestSubscription / DeliveryRecord。
- **触发实现**：进 Phase A 前先实测指数 `getQuote`，证伪则 DB.4 回炉。
- **不在范围（backlog）**：App 内简报页 / 历史回看 / 校准（v1.4 砍）、板块轮动 / 宽度 / VIX、双向 bot 回调、勿扰时段。

---

## Web / 股票分析工作台 UX

> 2026-05-23 与用户讨论"`/stock/:symbol` 工作台 UX 加强"沉淀。产品定位：**短期是"股票分析工作台"，不是行情终端**——首屏需股票头条但不做 K 线 / 量能 / 机构持仓等重型详情；图表后续放 `/stock/:symbol/chart` 二级页面。

### Sprint 1（P0 阻塞 + 主体改进）

- **`/stock/:symbol` 直达链接 / stockId resolution（P0 阻塞）**
  - 价值：当前 stockId/market/name 都从 URL query 读，缺 stockId 时"开始 AI 分析"按钮 disabled，只 toast"缺少股票记录"。直达链接 `/stock/AAPL`、分享链接被人手敲短、外链回流全部失效。
  - 设计方向：进入页面后按 `symbol + market` 查 DB；缺则触发 search；search 命中后展示"添加到自选并开始分析"恢复路径。

- **历史切换 state bug（P0）**
  - 价值：`analysisId` effect 守卫 `if (stream.status !== 'idle') return`。用户看完一份 completed report 后改 URL 切到另一个 analysisId，整页不会重渲染。历史下拉前置依赖。
  - 设计方向：移除 idle 守卫；切换 analysisId 时 reset stream + 重新走加载分支。

- **结论展示三件套去重（P0）**
  - 价值：综合分析完成后 `ConclusionBanner`（顶 banner）+ 右侧 `OverallConclusionCard` + summary section `ComprehensiveSummaryCard` 三个都展示 signal/confidence/oneLiner，用户分不清主结论在哪。
  - 设计方向：顶 banner 唯一主结论；右侧栏改"各维度信号 + 最大风险"；summary section 删除 OverallConclusion 重复，只保留 markdown + bull/bear case + 风险卡。

- **杂项修补（P0）**
  - 删开发用 `console.log`；`document.title = "${symbol} · ${name}"`；`LeftSectionNav` 增加 `skipped` 状态颗粒度；失败 banner 中"失败维度"按钮在 single-section 时无效，删守卫；`formatAnalysisTime` 加年份字段避免跨年混淆。

- **股票头条 header（P1，需新增后端 endpoint）**
  - 价值：首屏除"开始分析"外完全不展示股票即时事实，被迫先跑分析才能看到任何数据。
  - 设计方向：
    - 后端新增 `GET /api/stocks/:stockId/quote`（最小版，5 字段：price / change / changePct / marketState / asOf）；failure → 200 + `degraded: true`。
    - 后端新增 `GET /api/stocks/:stockId/profile`（市值 / 财报日 / sector / industry）；可慢可降级，不阻塞首屏。
    - 前端 header 下加 quote strip + 自选状态 toggle + 上次分析结论 chip。

- **术语去工程化（P1）**
  - 价值：分析进度条上的"事实快照已就绪 / 上限·中"等工程语言普通用户读不懂。
  - 决策：普通模式下收敛为单行"数据质量说明"；技术细节挪进 `?dev=1` debug drawer。

- **错误信息脱敏（P1）**
  - 价值：失败 banner 把 `latestFailureMessage` 整段塞进 `<pre>`，可能含 provider 名 / API URL / 内部 stack。开源前尤其敏感。
  - 设计方向：user-friendly 文案 + 折叠"技术细节"（默认 collapsed）。

### Sprint 2（价值能力）

- **报告底部 actions bar**
  - 价值：跑完综合分析底部无任何 actions，用户走到末尾就没下文。
  - 设计方向：复制 markdown / 导出 / "再跑一次（同 type 同 model）" / 加入自选（如未加）。

- **citation 跨维度归并视图**
  - 价值：综合分析每个 section 自己列 citations，9 个维度引用同一篇 SEC 10-K 时用户看到 9 次，削弱可信感。
  - 设计方向：综合分析底部新增"参考资料"section，所有 sections.citations 去重 + 按 domain/source 分组。

- **"返回"语义修复**
  - 价值：当前 hardcoded `<Link href="/watchlist">返回自选股</Link>`，从 /history、搜索、外链进来语义不对。
  - 设计方向：`router.back()` + fallback `/watchlist`，或改 breadcrumb。

### Sprint 3（机动）

- **mobile 适配**：左 nav 在 < lg 变 horizontal scrollable sticky tabs；RightInsightsPanel 折成展开/收起按钮默认收起。
- **AnalysisForm 改 sheet/dialog**：当前在 completed 状态以 inline Card 浮在结果上方语义模糊，改成明确的 sheet 或 dialog。

### Sprint 4+ / 待评估

- 快速/深度 preset / 时间窗 —— 见 "Analysis 模块"
- `?dev=1` debug drawer 完整化：snapshot / SSE event 原始 view，给开发者用
- 导出 PDF（vs 当前 markdown 复制）—— 按用户反馈决定
- 跑完后"上一次 vs 这次"diff 视图 —— 长期

- **股票详情 header profile 字段退化（板块 / 行业 / 下次财报）**
  - 背景：`GET /api/stocks/:symbol` 的 quote/profile 已从失效的 Yahoo v7/v10（裸 fetch，2024+ 强制 crumb → 全 401）迁到 analysis 包的 FinancePort（US/HK Yahoo v8 chart + crumb'd summaryDetail，CN 腾讯/东财）。
  - 现状：profile 现在只剩 `marketCap`（从 Quote 里带出，CN 已 ×1e8 归一）。analysis 的 `yahoo.getProfile` 未实现、CN connector 也不产 sector/industry/nextEarningsDate，所以这三个字段在 header 暂时不显示。
  - 方向：给 analysis FinancePort 补 `getProfile`（Yahoo summaryProfile + calendarEvents module，复用现有 crumb 缓存；CN 走东财 F10），再在 `StockService.fetchQuoteAndProfile` 填回。
  - 关联：[link-uses-yahooSymbol 路由约定] —— 详情页 symbol 不匹配已用 `findBySymbolAndMarket` 的 yahooSymbol 回退兜住；长期可考虑前端路由直接用 canonical symbol。

---

## v1 / 开源前 backlog

- **HK financials connector — 解决 HK 基本面数据零结构化覆盖**
  - **状态**：US (SEC EDGAR XBRL) + CN (Eastmoney datacenter-web) 已交付（见 ARCHITECTURE.md §13）；HK 待启动。
  - 价值：当前 HK 股票（如 00700 腾讯）VALUATION / FUNDAMENTAL 维度没结构化财报，靠 LLM `webSearch` 抓 seekingalpha / stockanalysis；引用质量不稳定、token 成本高。开源后是被反问"为啥跟 ChatGPT 直接问没差"的弱点。
  - 设计方向：HKEX 官方 `https://www1.hkexnews.hk/` 有免费 disclosure search（XML/JSON 公开），按 stock code 查近 X 年 announcements。两条路：
    - **轻量**：~2 天，Tavily site-restricted search 当 HK filings 临时方案，tier=C
    - **完整**：~1.5-2 周，自写 `hkex-disclosure` connector，tier=A，与 SEC EDGAR 对齐
  - 触发：HK 用户反馈"为什么 HK 股票没有 filing 数据"；或开源前最后一波打磨。
  - 注意：HKEX 部分披露是 PDF 不是结构化数据，需 scrape 或 LLM 抽取兜底；EAV 格式与 SEC XBRL 不一致，concept-mapping 要重写。

- **Summary phase citation schema 加固**
  - 价值：跑全栈 smoke（AAPL Comprehensive 9 维 + summary）时偶发 summary phase LLM 输出的 `evidence[]` 末尾几项 citations 缺 `title / url / sourceType / retrievedAt` 必填字段，schema 拒后 `structuredOutputWithRepair` repair 一次后仍坏，抛错退出。生产场景下用户看到的是 analysis 落 FAILED 状态。
  - 设计方向：
    1. summary system prompt 强化：明确"每个 evidence.citations[i] 必须 4 字段齐全，缺任一字段视为该 evidence 无效"
    2. structured-output repair 提示加 zod error diff（拼具体 path 让 LLM 知道修哪里）
    3. 评估改设计："先收集所有 dim citations → code-side 合并 → 不让 LLM 重新输出 citations 数组"
    4. 测试：parity-check.ts smoke 加 summary phase 校验断言
  - 触发：用户反馈"完整分析跑到最后失败"。

---

## Watchlist / 自选股

> 暂无登记。

---

## Settings / 通用

### 移除已废弃的 `allowWebSearchFallback` 用户开关（2026-05-31 登记）

- 背景：web_search 兜底已改为「结构化数据不可用(无 pack / 缺 financials)时无条件恢复」,
  apps/api 对每次 run 恒开(`analysis.service` 硬编码 `allowWebSearchFallback = true`)。
  原 per-user opt-in 因此失效。
- 待清理:`User.allowWebSearchFallback` 列(+ Prisma migration)、`auth.controller`
  的 GET `/auth/me` 响应字段 + PATCH body、AI-Settings 前端 toggle UI。
- 注意:`AdapterContext.allowWebSearchFallback` + `ComprehensiveOptions.allowWebSearchFallback`
  **不删** —— 它们仍是 workflow 的「recovery-enabled」开关(生产恒开、测试显式开),
  只是不再来自 User 设置。
- 触发:做用户设置面板下一轮清理时一并处理;或确认产品上不再需要该 toggle 后即可移除。

---

## 基础设施 / 监控

### 技术债 + 第三方 review 沉淀（2026-05-26 登记）

- **INDUSTRY 维度 web search 单点故障**
  - 现状：INDUSTRY 维度唯一数据源是 Tavily。Tavily 挂 → INDUSTRY 整段空白
  - 触发：Tavily 出故障，或用户配的 Anthropic/OpenAI 不带 web search
  - 已部分缓解（2026-05-28 §17.4.4）：用户可在 settings 自配 Tavily/SearXNG key，避免依赖运维侧单一 env；prompt 降级也已落地（`freshness.ts:30-40` 的 `webSearchAvailable=false` 分支）
  - 仍待办：SnapshotV2 加 industry overview connector（SEC 10-K item 1 + 同行 yahoo sector），把 INDUSTRY 从纯 web-search 改为「web-search + connector」双轨

- **peer 表静态化**
  - 现状：`packages/analysis/src/compute/peer-table.ts` 用静态 sector→top peers 映射；新上市 / 换赛道的票就空
  - 方向：connector 动态拉同 sector top-N 市值股票，静态表降级为 fallback

- **HK 财务数据缺失 prompt 提示**
  - 现状：HK 票（如 00700）没接 financials connector，VALUATION / FUNDAMENTAL 维度 prompt 没主动告知 LLM
  - 风险：LLM 凭空编造或用 quote 推导 PE/PB
  - 方向：dimension prompt 检测 `facts.financials` 缺失时注入"HK 财务数据 v1 不可用，仅基于 quote / news 分析"
  - 关联：HK financials connector backlog（见上 v1 段）

- **In-memory ToolCacheService 内存监控**
  - 现状：`apps/api/src/lifecycle/tool-cache.service.ts` LRU 有 size cap，但久驻进程下没 GC metrics
  - 方向：暴露 `cacheSize / hitRate / evictionCount` 给 telemetry，超阈值告警

- **AiProviderSetting.apiKey 明文落库**
  - 现状：beta 单实例阶段可接受
  - 风险：DB 备份外发 / SaaS 化时会被审计抓
  - 方向：Prisma schema 字段加 `/// @encrypted-todo` 注释占位；引入加密时配套 key 轮换流程
  - 关联：AI Provider Phase 2 重新启用 apiKey 加密（见上）

- **CN 数据源地理受限**
  - 现状：Eastmoney / tencent 在境外 IP 偶发 429 / 拒连
  - 方向：换 sina/akshare 镜像 或加 sg/jp proxy

- **comparison（多股对比）功能彻底无入口**
  - 现状：comparison runtime 已移除；当前只能跑单股
  - 用户场景："茅台 vs 五粮液 / SaaS 三家对比" 高频
  - 方向：v1.1 单独 RFC，可选实现：前端串行跑两次 single 后拼装 / 后端复活 batch endpoint + 单 stock workflow 并行

---

## Daily Brief（定时行情简报）

> Phase A 已落地（task1-7 + 前端订阅 UI）：订阅 CRUD / 指数数据层 / Brief Generator /
> ChannelAdapter（Webhook+飞书+TG）/ 触发层 / 真实投递验证（US/CN/HK × 飞书/TG）。

### 已偏离 PRD 的决策（需回退时参考）

- **D7 调度：内置 setInterval 替代外部 cron（单副本场景）**
  - 偏离：原 PRD 定案选「外部 heartbeat（模式 C）」，本期改为 api 进程内置 `DigestSchedulerService`（`setInterval` 15min tick + 复用 `resolveDigestWindow`，DST 仍由 market-hours 收口）。
  - 理由：单副本部署，外部 cron 配置成本高；内置省运维。
  - 回退触发：**多副本部署**（内置会让每个实例重复触发，即便幂等也会重复生成烧 LLM）→ 回退到外部 cron，或加 Redis leader election。
  - 已知限制（单副本可接受）：进程在窗口内崩溃/重启 → 该轮可能漏发且无外部告警（靠下次窗口补）；`setInterval` 非精确定时（事件循环繁忙 tick 延迟）。
  - 保留 `POST /api/digest/trigger` endpoint：dev 手动触发 / 补偿用。

### Phase B 待办

- **飞书签名校验**：`FeishuAdapter` 未实现 secret 签名，开了「签名校验」的飞书机器人会投递失败。算法：timestamp + secret → HMAC-SHA256 → base64（飞书自有）。
- **DB.2 量能/换手字段**：契约 `WatchlistItemBrief` 未含 volume/换手率（POST 专属），compute 有数据但未渲染。
- **DB.2 财报事件**：`events` 只从 unlockCalendar 派生解禁（CN），财报（earnings）未做（snapshot 无 news/earnings 字段，需接财报日历数据源）。
- **CN 节假日日历**：当前按窗口时间发，节假日会基于上一交易日数据发简报（dataAsOf 反映真实时点）。精确判断需静态日历或当日成交校验。
- **钉钉/企微/Slack adapter**：首批只 Webhook+飞书+TG。
- **盘前/后精确价**：FinancePort 补盘前/后价（当前用 regularMarketPrice）。

### Phase C backlog

- 板块轮动/宽度/VIX；邮件渠道；宏观事件日历。
