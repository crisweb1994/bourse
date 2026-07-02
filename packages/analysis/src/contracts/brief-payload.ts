import { z } from 'zod';

/**
 * Daily Brief 契约（docs/prd-daily-brief.md v1.5）。
 *
 * Schema-first（不变式 #4）。本文件是 digest 子系统的全部 zod 契约：
 *  - ChannelConfig：DigestSubscription.channels 的 JSON 形状（订阅凭证）
 *  - BriefPayload：生成层 → ChannelAdapter 的运行时内存结构（v1.4 不落库）
 *
 * 放在 analysis/contracts 是因为 zod 依赖在 analysis 包（api 不直接依赖 zod，
 * pnpm strict）。指数数据层（fetchIndexQuote 等）也在 analysis 包，契约同包一致。
 * api digest module 从 @bourse/analysis 消费这些类型。
 */

// ============================================================================
// 渠道配置（订阅凭证，存 DigestSubscription.channels JSON）
// ============================================================================

export const ChannelType = z.enum([
  'WEBHOOK',
  'FEISHU',
  'DINGTALK',
  'WECOM',
  'TELEGRAM',
  'SLACK',
  // Phase C: EMAIL
]);
export type ChannelType = z.infer<typeof ChannelType>;

/**
 * 渠道配置 discriminated union。各平台字段不同：
 *  - incoming webhook 类（飞书/钉钉/企微/Slack）：url [+ secret]
 *  - Telegram：Bot Token + Chat ID（非 webhook）
 *  - 通用 Webhook：url + HMAC secret
 * 凭证明文落库（同 AiProviderSetting.apiKey 策略，加密属 Phase 2）。
 */
export const ChannelConfig = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('WEBHOOK'),
    url: z.string().url(),
    secret: z.string().min(1),
  }),
  z.object({
    type: z.literal('FEISHU'),
    url: z.string().url(),
    secret: z.string().optional(), // 飞书自定义机器人签名校验可选
  }),
  z.object({
    type: z.literal('DINGTALK'),
    url: z.string().url(),
    secret: z.string().min(1), // 钉钉必填签名（timestamp + secret）
  }),
  z.object({
    type: z.literal('WECOM'),
    url: z.string().url(),
  }),
  z.object({
    type: z.literal('TELEGRAM'),
    botToken: z.string().min(1),
    chatId: z.string().min(1),
  }),
  z.object({
    type: z.literal('SLACK'),
    url: z.string().url(),
  }),
]);
export type ChannelConfig = z.infer<typeof ChannelConfig>;

// ============================================================================
// BriefPayload（两段式，发给 ChannelAdapter）
// ============================================================================

export const IndexQuoteBrief = z.object({
  symbol: z.string(),
  name: z.string(),
  changePct: z.number(),
  vsSma50: z.number().nullable(), // 距 SMA50 %，null = 数据不足
  rsi14: z.number().nullable(),
});
export type IndexQuoteBrief = z.infer<typeof IndexQuoteBrief>;

export const WatchlistItemBrief = z.object({
  symbol: z.string(),
  changePct: z.number(),
  /** 距上次分析的价格漂移 %。null = 该票无历史 Analysis（从没分析过）。 */
  driftSinceLastAnalysis: z.number().nullable(),
  rsi14: z.number().nullable(),
  vsSma50: z.number().nullable(),
  vsSma200: z.number().nullable(),
  events: z.array(z.object({ kind: z.string(), date: z.string() })).default([]),
  /** 异动深入 markdown。null = 未命中异动触发 / 用户未配 provider。 */
  deepDive: z.string().nullable(),
});
export type WatchlistItemBrief = z.infer<typeof WatchlistItemBrief>;

export const SectorAttribution = z.object({
  sector: z.string(),
  changePct: z.number(),
});
export type SectorAttribution = z.infer<typeof SectorAttribution>;

export const ReanalyzeHint = z.object({
  symbol: z.string(),
  reason: z.string(),
});
export type ReanalyzeHint = z.infer<typeof ReanalyzeHint>;

export const BriefPayload = z.object({
  market: z.enum(['US', 'CN', 'HK']),
  session: z.enum(['PRE', 'POST']),
  generatedAt: z.string().datetime(),
  /** Provenance（不变式 #5）：简报数据时点。 */
  dataAsOf: z.string(),
  marketOverview: z.object({
    indices: z.array(IndexQuoteBrief),
    /** null = 用户未配 AiProviderSetting，降级纯数字（无 AI 解读）。 */
    interpretation: z.string().nullable(),
  }),
  watchlist: z.object({
    items: z.array(WatchlistItemBrief),
    /** POST 专属板块归因；PRE 为空数组。 */
    sectorAttribution: z.array(SectorAttribution).default([]),
    interpretation: z.string().nullable(),
    reanalyzeHints: z.array(ReanalyzeHint).default([]),
  }),
});
export type BriefPayload = z.infer<typeof BriefPayload>;
