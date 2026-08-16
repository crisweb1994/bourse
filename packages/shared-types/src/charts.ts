import { z } from 'zod';

/**
 * Chart API DTOs — visualization technical design §五⑥⑦ (v2.2).
 *
 * Single source of truth shared by apps/api (response validation) and
 * apps/web (type derivation via z.infer). Declared here — not in
 * @bourse/analysis — because the web app depends only on shared-types and
 * the dependency graph must not grow a web→analysis edge.
 *
 * Rationale for `z.unknown()` passthrough fields (technical/valuation/
 * researchCoverage): those structures are owned and validated by the
 * analysis package's own zod contracts at generation time; re-declaring
 * them here would create a second schema that can drift. Only
 * ChartPriceSeriesSchema is precise because it is NEW and shared by both
 * endpoints — that is where a shared schema earns its keep.
 */

const qualityTier = z.enum(['A', 'B', 'C', 'D', 'E']);

export const ChartPriceSeriesBarSchema = z.object({
  t: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  o: z.number().finite(),
  h: z.number().finite(),
  l: z.number().finite(),
  c: z.number().finite(),
  v: z.number().nullable(),
});
export type ChartPriceSeriesBar = z.infer<typeof ChartPriceSeriesBarSchema>;

export const ChartPriceSeriesSchema = z.object({
  bars: z.array(ChartPriceSeriesBarSchema).max(1200),
  basis: z.enum(['raw', 'derived', 'mixed']),
  week52High: z.number().nullable(),
  week52Low: z.number().nullable(),
  asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  sourceTier: qualityTier,
});
export type ChartPriceSeries = z.infer<typeof ChartPriceSeriesSchema>;

const chartProvenance = z.object({
  quote: qualityTier.optional(),
  history: qualityTier.optional(),
  financials: qualityTier.optional(),
  /** C10 北向 fact 的来源等级。 */
  northbound: qualityTier.optional(),
  /** C11 解禁公告 fact 的来源等级，不能复用北向来源。 */
  unlockCalendar: qualityTier.optional(),
  corporateActions: qualityTier.optional(),
});

/**
 * GET /api/analysis/:id/evidence — narrow projection of the persisted
 * evidence snapshot payload for chart rendering. `available:false` (with a
 * stable reason) lets the client distinguish "no snapshot yet" from
 * transport errors instead of hanging in a loading state (design P6/R-6).
 */
export const ChartEvidenceResponseSchema = z.object({
  available: z.boolean(),
  reason: z.enum(['no_snapshot', 'not_terminal']).optional(),
  capturedAt: z.string(),
  degraded: z.boolean(),
  dataAvailability: z.object({
    complete: z.array(z.string()),
    missing: z.array(z.object({
      field: z.string(),
      reason: z.string(),
    })),
    fallbacks: z.array(z.string()),
  }),
  researchCoverage: z.unknown().nullable().optional(),
  chartFacts: z.object({
    quote: z.object({
      price: z.number(),
      changePct: z.number().nullable(),
      currency: z.string().nullable(),
      asOf: z.string().nullable(),
      /** TTM PE（pack facts.pe）；C2 当前分位标记用。 */
      pe: z.number().nullable(),
    }).nullable(),
    priceSeries: ChartPriceSeriesSchema.nullable(),
    /** ComputedTechnicalIndicators subset (incl. optional {t,v} series). */
    technical: z.unknown().nullable(),
    /** { periodTrends } subset of ComputedFinancialRatios. */
    ratios: z.object({ periodTrends: z.array(z.unknown()) }).nullable(),
    /** peHistorySeries / pe5y* / impliedGrowthRate + dcfSensitivity subset. */
    valuation: z.unknown().nullable(),
    /** C8: PeerComparison (subjectVsPeerMedian per metric). */
    peerComparison: z.unknown().nullable(),
    /** C10 (CN): genuine northbound flow rows [{date,hgt,sgt}]. */
    northbound: z.unknown().nullable(),
    /** C10 (CN): stock-connect holding snapshots, kept separate from flow. */
    northboundHoldings: z.unknown().nullable().optional(),
    /** C11 (CN): unlock calendar rows [{date,shares,marketValue,type}]. */
    unlockCalendar: z.unknown().nullable(),
    /** Corporate-action dates used as optional C1 event markers. */
    corporateActions: z.unknown().nullable().optional(),
  }),
  provenance: chartProvenance,
});
export type ChartEvidenceResponse = z.infer<typeof ChartEvidenceResponseSchema>;

/**
 * GET /api/stocks/:symbol/history?market=&days= — L1 stock-page chart feed.
 * Same shape as chartFacts' priceSeries/technical so C1 renders identically
 * in and out of an analysis (design ⑦).
 */
export const StockHistoryResponseSchema = z.object({
  priceSeries: ChartPriceSeriesSchema,
  technical: z.unknown(),
  /** Server-computed marker used by C13; null when no move crosses the threshold. */
  anomalyIndex: z.number().int().nonnegative().nullable().optional(),
  provenance: chartProvenance,
});
export type StockHistoryResponse = z.infer<typeof StockHistoryResponseSchema>;

export const StockHistoryBatchItemSchema = z.object({
  key: z.string().min(1),
  response: StockHistoryResponseSchema,
});

export const StockHistoryBatchResponseSchema = z.object({
  items: z.array(StockHistoryBatchItemSchema),
  missing: z.array(z.object({ key: z.string().min(1), reason: z.string().min(1) })),
});
export type StockHistoryBatchResponse = z.infer<typeof StockHistoryBatchResponseSchema>;

/** Whitelisted windows (design ⑦); default 365 = the fixed chart window D1. */
export const STOCK_HISTORY_DAYS_WHITELIST = [30, 90, 365, 1095] as const;
export type StockHistoryDays = (typeof STOCK_HISTORY_DAYS_WHITELIST)[number];
