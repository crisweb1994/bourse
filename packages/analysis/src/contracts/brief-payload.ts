import { z } from 'zod';
import {
  ChannelType as SharedChannelType,
  DigestSession as SharedDigestSession,
  Market as SharedMarket,
} from '@bourse/shared-types';

/**
 * Daily Brief 契约（docs/prd-daily-brief.md v1.5）。
 *
 * Schema-first（不变式 #4）。本文件是 digest 子系统的全部 zod 契约：
 *  - ChannelConfig：DigestSubscription.channels 的 JSON 形状（订阅凭证）
 *  - BriefPayload：生成层 → ChannelAdapter 的运行时内存结构（v1.4 不落库）
 *
 * 历史注:曾因「api 不直接依赖 zod」放在 analysis——该前提已过时(shared-types
 * 依赖 zod)。ChannelConfig 属 API 订阅契约,迁移 shared-types 归 T2(KISS C2-3);
 * 指数数据获取(fetchIndexQuote 等)实现与导出均在 @bourse/market-data。
 *
 * Market / DigestSession / ChannelType 通过 z.nativeEnum 复用 @bourse/shared-types
 * 的 const-object（与 enums.ts 的 AnalysisMode/Signal 同款桥接），单一来源。
 */

// ============================================================================
// 渠道配置（订阅凭证，存 DigestSubscription.channels JSON）
// ============================================================================

// 渠道契约已单源到 @bourse/shared-types/channel-config(KISS T2-2)——订阅凭证
// 是 API↔web 公共契约而非分析契约。此处保留同名重导出以兼容既有导入。
export { ChannelConfig, ChannelType } from '@bourse/shared-types';

// ============================================================================
// BriefPayload（两段式，发给 ChannelAdapter）
// ============================================================================

export const IndexQuoteBrief = z.object({
  symbol: z.string(),
  name: z.string(),
  changePct: z.number(),
  vsSma50: z.number().nullable(), // 距 SMA50 %，null = 数据不足
  rsi14: z.number().nullable(),
  /** C14（visualization §5.2）：近 30 个收盘（旧→新），供 Webhook 渠道渲染
   *  unicode sparkline。additive optional — 旧 payload 无此字段。 */
  closes30d: z.array(z.number()).max(30).optional(),
  /** C14：unicode sparkline（▁▂▃…），WebhookAdapter 出站时注入。 */
  sparkline: z.string().optional(),
  /** C14：Webhook 接收方可直接插入的 inline SVG（无外部资源）。 */
  sparklineHtml: z.string().optional(),
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
  /** C14：近 30 个收盘（旧→新），供 Webhook 渠道渲染 inline sparkline。 */
  closes30d: z.array(z.number()).max(30).optional(),
  sparkline: z.string().optional(),
  sparklineHtml: z.string().optional(),
  events: z.array(z.object({ kind: z.string(), date: z.string() })).default([]),
  /** Latest completed earnings revision, when one exists for this stock. */
  earnings: z.object({
    revisionId: z.string(),
    periodEndOn: z.string(),
    periodType: z.string(),
    publishedAt: z.string(),
    sourceUrl: z.string().url(),
    statusSummary: z.object({
      total: z.number().int().nonnegative(),
      reconciled: z.number().int().nonnegative(),
      pending: z.number().int().nonnegative(),
      conflicted: z.number().int().nonnegative(),
      structuredOnly: z.number().int().nonnegative(),
    }),
    topFacts: z.array(z.object({ metricCode: z.string(), value: z.unknown() })).max(6),
  }).nullable().optional(),
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
  market: z.nativeEnum(SharedMarket),
  session: z.nativeEnum(SharedDigestSession),
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

export const EarningsNoticePayload = z.object({
  kind: z.enum(['NEW_CARD', 'UPDATE', 'CORRECTION']),
  revisionId: z.string(),
  previousRevisionId: z.string().optional(),
  stockId: z.string(),
  symbol: z.string(),
  name: z.string(),
  market: z.nativeEnum(SharedMarket),
  periodEndOn: z.string(),
  periodType: z.string(),
  publishedAt: z.string().datetime(),
  generatedAt: z.string().datetime(),
  sourceUrl: z.string().url(),
  statusSummary: z.object({
    total: z.number().int().nonnegative(),
    reconciled: z.number().int().nonnegative(),
    pending: z.number().int().nonnegative(),
    conflicted: z.number().int().nonnegative(),
    structuredOnly: z.number().int().nonnegative(),
  }),
  topFacts: z.array(z.object({
    metricCode: z.string(),
    value: z.union([
      z.object({ kind: z.literal('scalar'), value: z.string() }),
      z.object({ kind: z.literal('range'), min: z.string(), max: z.string() }),
    ]),
    currency: z.string().optional(),
    unit: z.string(),
  })).max(6),
});
export type EarningsNoticePayload = z.infer<typeof EarningsNoticePayload>;
