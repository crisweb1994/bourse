import { z } from 'zod';
import { Market as SharedMarket, DigestSession as SharedDigestSession } from '@bourse/shared-types';

/**
 * Daily Brief 契约(KISS Codex #5:自 @bourse/analysis 迁入 digest 域——
 * 这些是 API 内部生成→投递的运行时结构,仅 apps/api/src/digest 与
 * earnings-notice 消费,不是分析包契约)。ChannelConfig 的单源在
 * @bourse/shared-types/channel-config。
 */

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
