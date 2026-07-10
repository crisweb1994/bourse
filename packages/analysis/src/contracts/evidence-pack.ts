import { z } from 'zod';

// Immutable fact pack consumed by analysis workflows. Model output may only
// cite URLs present in `allowedUrls`.

export const FinancialSnapshot = z.object({
  price: z.number().optional(),
  marketCap: z.number().optional(),
  pe: z.number().optional(),
  revenueGrowth: z.number().optional(),
  netMargin: z.number().optional(),
  fcfYield: z.number().optional(),
});
export type FinancialSnapshot = z.infer<typeof FinancialSnapshot>;

export const NewsItem = z.object({
  title: z.string().min(1),
  url: z.string().url(),
  publishedAt: z.string().datetime(),
  sentiment: z.enum(['POSITIVE', 'NEGATIVE', 'NEUTRAL']).optional(),
});
export type NewsItem = z.infer<typeof NewsItem>;

export const ValuationSnapshot = z.object({
  peerPE: z.array(z.number()).optional(),
  historicalPE: z
    .object({
      p25: z.number(),
      p50: z.number(),
      p75: z.number(),
    })
    .optional(),
});
export type ValuationSnapshot = z.infer<typeof ValuationSnapshot>;

/**
 * RFC rfc-evidence-pack-web-search-fallback: per-pack data-source quality
 * marker. Absent / `NONE` = pack was built normally; `WEB_SEARCH_FALLBACK`
 * = v2 CN tool path failed on a non-transient error AND user had
 * `allowWebSearchFallback` on, so the LLM web_search v1 builder produced
 * this pack. Downstream consumers (dims / debate Judge / UI) MUST treat
 * any degraded pack as reduced reliability — Judge.confidence is clamped
 * to MEDIUM and dims listed in `missingPrivateFields` may be skipped.
 */
export const EvidencePackDegradeMeta = z.object({
  degradedSource: z.enum(['NONE', 'WEB_SEARCH_FALLBACK']).default('NONE'),
  fallbackReason: z
    .object({
      kind: z.enum(['AUTH', 'NETWORK', 'RATE_LIMIT_HARD', 'OTHER']),
      failedTools: z.array(z.string()),
      message: z.string(),
    })
    .optional(),
  /**
   * Private-data field names the v2 path produced but v1 web_search cannot
   * reconstruct (北向 / 龙虎榜 / 解禁 / 一致预期). Dimensions whose
   * `requiresPrivateData` intersects this list are skipped to avoid
   * letting the LLM fabricate those numbers from generic search snippets.
   */
  missingPrivateFields: z
    .array(
      z.enum(['northboundFlow', 'lhb', 'unlockCalendar', 'consensusEps']),
    )
    .default([]),
});
export type EvidencePackDegradeMeta = z.infer<typeof EvidencePackDegradeMeta>;

export const EvidencePack = z.object({
  schemaVersion: z.literal('evidence-pack-v1'),
  symbol: z.string().min(1),
  market: z.string().min(1),
  capturedAt: z.string().datetime(),
  financialSnapshot: FinancialSnapshot,
  news: z.array(NewsItem),
  valuation: ValuationSnapshot,
  riskFacts: z.array(z.string().min(1)),
  allowedUrls: z.array(z.string().url()),
  /**
   * Optional for back-compat: legacy packs (pre-RFC, persisted in DB)
   * deserialize without this field, and consumers should treat absent
   * as `{degradedSource: 'NONE', missingPrivateFields: []}`.
   */
  dataAvailability: EvidencePackDegradeMeta.optional(),
});
export type EvidencePack = z.infer<typeof EvidencePack>;

// RFC-02: v1 + v2 discriminated union. v1 stays as 'EvidencePack' (kept
// stable so existing debate/SSE/workflow consumers don't have to change).
// v2 is imported separately for code-driven A-share Stage 0; callers that
// need to accept either version use EvidencePackAny.
import { EvidencePackV2 } from './evidence-pack-v2';

export const EvidencePackAny = z.discriminatedUnion('schemaVersion', [
  EvidencePack,    // 'evidence-pack-v1' — debate workflow, any market
  EvidencePackV2,  // 'evidence-pack-v2' — comprehensive Stage 0, CN only
]);
export type EvidencePackAny = z.infer<typeof EvidencePackAny>;
