<div align="center">

# Bourse

**让 AI 像顶级分析师一样研究股票 —— 而不是像 ChatGPT 那样编造数字**

一个开源的 AI 股票研究平台。9 个维度并行分析，6 位投资大师视角，实时流式输出。
支持 **A 股 / 美股 / 港股**，自带 SEC EDGAR / Yahoo Finance / 东方财富 / akshare 数据源。

[![License](https://img.shields.io/badge/license-MIT-green.svg)](#license)
[![Next.js](https://img.shields.io/badge/Next.js-15-black?logo=next.js)](https://nextjs.org/)
[![NestJS](https://img.shields.io/badge/NestJS-11-E0234E?logo=nestjs)](https://nestjs.com/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript)](https://www.typescriptlang.org/)
[![Tailwind CSS](https://img.shields.io/badge/Tailwind-v4-38B2AC?logo=tailwind-css)](https://tailwindcss.com/)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](#贡献)

[功能](#为什么是-bourse) ·
[快速开始](#快速开始) ·
[架构](#架构一图看懂) ·
[路线图](#路线图)

</div>

---

## 为什么是 Bourse

> 市面上大多数"AI 股票助手"是把 ChatGPT 套层皮：让模型自己算 PE、自己拍 RSI、自己猜营收。
> 数字幻觉随处可见，没法当严肃工具用。

Bourse 做了一个朴素但关键的架构选择：

| | 常见做法 | Bourse |
|---|---|---|
| 财务比率（PE / ROE / 毛利率…） | LLM 自己算 | **TypeScript 确定性计算**，结果注入 prompt |
| 技术指标（RSI / MACD / 布林带） | LLM 自己拍 | **TypeScript 精确计算**，LLM 只负责解读 |
| 同行对比 / 历史百分位 | LLM 一顿编 | **代码算出中位数和分位**，LLM 写结论 |
| 数据来源 | 全靠 web search | **真实 connector**：SEC EDGAR / Yahoo / 东财 / akshare |
| 引用链 | 没有或瞎编 | **每个 citation 强制带 `retrievedAt`** |

**一句话：代码负责"事实"，LLM 只负责"判断"。** 这意味着分析的客观部分永远是准确、可复现、可审计的。

---

## 核心能力

### 9 维度并行分析

一次"综合分析"，并行跑 9 个独立维度，互不阻塞，谁先好谁先显示：

| 维度 | 覆盖范围 |
|---|---|
| **基本面** | 商业模式 / 财务趋势 / 盈利质量 |
| **估值** | DCF / 反向 DCF / 相对估值 |
| **行业竞争** | 行业格局 / 护城河 / 竞争地位 |
| **风险** | 公司风险 / 宏观风险 / 监管合规 |
| **技术面** | 趋势 / 关键价位 / SMA·RSI·MACD·Bollinger |
| **情绪** | 分析师共识 / 机构动向 / 内部交易 |
| **情景** | 牛 / 基 / 熊三情景 + 概率 + 催化剂 |
| **组合** | 风险/期限/风格匹配 + 仓位建议 |
| **治理** | 股权结构 / 管理层激励 / ROIC 趋势 |

### 6 位投资大师视角

可选 persona 让分析带上特定流派的判断框架：

**巴菲特**（价值 + 护城河） · **芒格**（多元思维模型） · **伯里**（逆向 + 危机嗅觉）
**伍德**（颠覆式增长） · **达摩达兰**（学院派估值） · **格雷厄姆**（深度价值）

### 多市场原生支持

| 市场 | 数据源 | 特色能力 |
|---|---|---|
| **A 股** | 东方财富 / akshare 镜像 | 北向资金 / 龙虎榜 / 解禁 |
| **美股** | Yahoo Finance / SEC EDGAR XBRL | 10-K / 10-Q / Insider Trading |
| **港股** | Yahoo Finance | 通用财务 + 技术指标 |

### 实时 SSE 流式输出

不是等几分钟最后给你一段，而是边算边推：

```
section_start → report_chunk × N → report_complete → structured_data
              → citation × N → section_complete → ... → done
```

支持断线续传（`?afterSeq=N`）+ 15 秒心跳 + 部分维度失败时其余维度照常完成。

### 自由切换 AI Provider

- 内置 Anthropic（Claude）+ OpenAI / OpenAI-compatible（DeepSeek / Kimi / 智谱 / 通义 / 火山方舟…）
- 每个用户可独立配置自己的 API Key，平台不强绑供应商
- 三层模型路由（Primary 主分析 / Utility 结构化抽取）

### 还有

- **GitHub OAuth + JWT + CSRF** 全套就位
- **私部署模式** —— `AUTH_REQUIRED=false` 一键关闭登录，内网用
- **一键 Docker 部署** —— `docker compose up` 完事

---

## 快速开始

### ⚡ 2 分钟极速体验（推荐 · 无需 GitHub OAuth）

```bash
git clone https://github.com/crisweb1994/bourse.git && cd bourse
cp .env.example .env
# 编辑 .env：粘贴一个 AI key（Anthropic 或 OpenAI/OpenAI 兼容任选其一）
docker compose --profile app up -d --build
```

打开 `http://localhost:3000`，搜索 `AAPL` 或 `贵州茅台`，直接开跑。
默认 `AUTH_REQUIRED=false` —— 单用户模式，免登录、免 OAuth、免数据库手动初始化。

### 本地开发模式

```bash
docker compose up -d                            # 仅起 Postgres
pnpm install && cp .env.example .env            # 粘贴 AI key
pnpm -F @bourse/api db:generate && db:push
pnpm dev                                        # api :3001 + web :3000
```

### 多用户 / 生产部署

需要 GitHub OAuth 登录、跨子域 cookie、CORS 白名单等生产配置？
参考 [`.env.production.example`](.env.production.example) 里的完整环境变量说明。

---

## 架构一图看懂

```
                 ┌─────────────────────────────────────────────┐
                 │            apps/web (Next.js 15)            │
                 │       Editorial Refined UI · SSE 渲染        │
                 └────────────────────┬────────────────────────┘
                                      │ JWT cookie + CSRF
                 ┌────────────────────▼────────────────────────┐
                 │          apps/api (NestJS · :3001)          │
                 │  Auth · Analysis 编排 · SSE · Prisma        │
                 └────────────────────┬────────────────────────┘
                                      │
                 ┌────────────────────▼────────────────────────┐
                 │       packages/analysis (核心包 · FFI)        │
                 │                                              │
                 │  ┌─────────────┐  ┌─────────────────────┐   │
                 │  │  Snapshot   │→ │      Compute        │   │
                 │  │  fetch ×1   │  │  Ratios / 技术指标  │   │
                 │  │  9 维共享    │  │  红旗 / 同行 / 百分位│   │
                 │  └──────┬──────┘  └──────────┬──────────┘   │
                 │         │ 注入 prompt        │              │
                 │         ▼                    ▼              │
                 │  ┌──────────────────────────────────┐       │
                 │  │   Dimensions × 9 (LLM 解读)      │       │
                 │  └──────────────────┬───────────────┘       │
                 │                     │ SSE                   │
                 │  ┌──────────────────▼───────────────┐       │
                 │  │   Personas (Buffett / Burry…)    │       │
                 │  └──────────────────────────────────┘       │
                 └──────────────────────────────────────────────┘
                          │
       ┌──────────────────┼──────────────────┐
       ▼                  ▼                  ▼
  Yahoo Finance      东方财富 / akshare       SEC EDGAR (XBRL)
```

**6 条硬不变式**（违反就是 bug）：

1. **代码计算，LLM 判断** —— 数字一律由 TS 算出来注入 prompt
2. **fetch 一次** —— 9 维共享 snapshot，不重复打外部接口
3. **Snapshot 是值** —— 中间态不落库，只持久化用户可见结果
4. **Schema-first** —— 所有 public 类型先写 zod，TS 类型 `z.infer` 派生
5. **Provenance 必填** —— citation 强制带 `retrievedAt`
6. **Auth + CSRF** —— mutating endpoint 必须带 `x-csrf-token`

---

## 技术栈

| 层 | 技术 |
|---|---|
| **Frontend** | Next.js 15 (App Router) · React 19 · Tailwind CSS v4 · lucide-react · react-markdown · `@microsoft/fetch-event-source` |
| **Backend** | NestJS · Passport (GitHub OAuth) · JWT httpOnly · Prisma ORM · class-validator |
| **Database** | PostgreSQL 16 (Docker · port 5434) |
| **AI** | Anthropic SDK · OpenAI SDK · OpenAI-compatible 任意 provider |
| **Connectors** | Yahoo Finance · SEC EDGAR XBRL · 东方财富 · akshare 镜像 · Tavily |
| **Monorepo** | Turborepo · pnpm workspaces |

---

## 项目结构

```
stock-suggest/
├── apps/
│   ├── api/                NestJS backend (:3001) · 6 Prisma models
│   └── web/                Next.js 15 frontend (:3000)
└── packages/
    ├── analysis/           核心包：connectors + compute + dimensions
    │                       + personas + workflows + snapshot + SSE 契约
    └── shared-types/       跨包枚举与类型
```

---

## 路线图

- [x] 9 维度并行分析 + COMPREHENSIVE workflow
- [x] 6 位投资大师 persona
- [x] A 股 / 美股 / 港股原生支持
- [x] SSE 流式 + 断线续传 + 部分失败容忍
- [x] 用户级 AI provider 自配
- [x] 用户级 Web Search adapter（Tavily / SearXNG）
- [ ] 多语言 UI（英文 / 日文）
- [ ] 移动端适配
- [ ] 自托管 LLM 评估（eval harness 已就绪，待 UI）
- [ ] 自定义维度 / 自定义 persona 编辑器

---

## 贡献

欢迎 issue / PR / RFC。提交前请确认改动不违反上文「6 条硬不变式」——
其中「代码计算，LLM 判断」与「Provenance 必填」是本项目的可信度底线，任何放宽需先开 issue 讨论。

特别欢迎的方向：
- 新 connector（券商 API / 财报数据源 / 另类数据）
- 新 persona（你心目中的投资大师）
- compute 层新指标（你觉得"代码该算却没算"的东西）
- prompt 优化 + eval 用例

---

## License

MIT.

---

<div align="center">

**如果这个项目对你有帮助，欢迎 Star 支持一下。**
**你的 Star 是开源继续投入的最大动力。**

</div>
