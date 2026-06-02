import { z } from 'zod';
import { FinancialsBundleSchema } from '../ports/financials';
import {
  ComputedFinancialRatiosSchema,
  ComputedTechnicalIndicatorsSchema,
  ComputedValuationSchema,
  HistoricalContextSchema,
  PeerComparisonSchema,
  RedFlagSchema,
} from '../compute';
import { Citation } from './citation';
import { Confidence } from './enums';

/**
 * RFC-02 Phase 1 + 1.x · A 股 EvidencePack v2.
 *
 * Schema design notes:
 * - `Fact<T>` carries provenance for every reusable value (CLAUDE.md §4.26):
 *   sourceUrl, asOf (when the data point is "as of"), retrievedAt (when our
 *   tool fetched it), sourceTier (A-E, code-side hard-coded), optional unit
 *   and currency where applicable.
 * - All `facts` fields are optional. Missing fields are publicly disclosed
 *   via `dataAvailability.missing` so dimension prompts know not to hallucinate.
 * - `market: 'CN'` is a literal — v2 only supports A-share in this RFC. US/HK/
 *   JP/UK continue to use the v1 LLM-based builder for now.
 * - `schemaVersion: 'evidence-pack-v2'` makes the type a discriminated-union
 *   member with v1, so consumers can route on a single field.
 */

// ===== Fact<T> with provenance =====

export const SourceTier = z.enum(['A', 'B', 'C', 'D', 'E']);
export type SourceTier = z.infer<typeof SourceTier>;

/**
 * Higher-order schema constructor: wraps any value schema with the provenance
 * fields required by §4.26. Usage:
 *   quote: Fact(z.number().positive()).optional()
 *
 * Each call creates a new zod schema instance, which is fine — the resulting
 * schemas are structurally identical and zod's safeParse caches internally.
 */
/**
 * v0.6 PRD §10.1 — `origin` marks which collection path produced this fact:
 *  - 'from_snapshot' (snapshot-backed wrapper path);
 *  - 'provider_native' (legacy v2 builder or wrapper augmentation).
 * Optional for backwards compat: pre-v0.6 facts omit this field.
 */
export const FactOrigin = z.enum(['from_snapshot', 'provider_native']);
export type FactOrigin = z.infer<typeof FactOrigin>;

export const Fact = <T extends z.ZodTypeAny>(value: T) =>
  z.object({
    value,
    asOf: z.string().datetime(),
    retrievedAt: z.string().datetime(),
    sourceUrl: z.string().url(),
    sourceTier: SourceTier,
    unit: z.string().optional(),
    currency: z.string().optional(),
    /** v0.6 PRD §10.1 — additive optional provenance discriminator. */
    origin: FactOrigin.optional(),
  });

// Generic Fact<T> type alias for callers that need to type a single fact.
export type FactOf<T> = {
  value: T;
  asOf: string;
  retrievedAt: string;
  sourceUrl: string;
  sourceTier: SourceTier;
  unit?: string;
  currency?: string;
  origin?: FactOrigin;
};

// ===== Phase 1 minimal facts (6 fields) =====

const RecentNewsItem = z.object({
  title: z.string().min(1),
  url: z.string().url(),
  publishedAt: z.string().datetime(),
  publisher: z.string().optional(),
});

/**
 * v0.6 PRD §9.3 — `facts.webDocuments` carries snapshot/web documents tagged
 * by source type. P0 schema (snapshot-backed wrapper writes when available).
 */
const WebDocumentItem = z.object({
  title: z.string().min(1),
  url: z.string().url(),
  publishedAt: z.string().datetime().optional(),
  sourceType: z.enum(['web', 'news', 'filing']).optional(),
});

/**
 * plan-v2 Path A — company profile (sector / industry / description / etc).
 * Sourced from Yahoo assetProfile (US/HK) or Eastmoney F10 基本资料 (CN). All
 * fields optional; the value object is present once any one is populated.
 */
const CompanyProfileFact = z.object({
  description: z.string().optional(),
  sector: z.string().optional(),
  industry: z.string().optional(),
  employees: z.number().int().nonnegative().optional(),
  website: z.string().optional(),
  marketCap: z.number().optional(),
});

export const MinimalFacts = z.object({
  quote: Fact(z.number().positive()).optional(),
  marketCap: Fact(z.number().positive()).optional(),
  // 3-letter ISO 4217 currency code; for CN always 'CNY'.
  currency: Fact(z.string().length(3)).optional(),
  pe: Fact(z.number()).optional(),
  /** plan-v2 Path A — company profile facts. */
  profile: Fact(CompanyProfileFact).optional(),
  latestFilingUrls: Fact(z.array(z.string().url())).optional(),
  recentNews: Fact(z.array(RecentNewsItem)).optional(),
  /** v0.6 PRD §9.3 P0 — snapshot web/news documents grouped here. */
  webDocuments: Fact(z.array(WebDocumentItem)).optional(),
  /**
   * RFC financials Phase 1 — 三表 + TTM bundle, US-only Phase 1。
   * `value` 是 FinancialsBundle (periods[] + currency + sourceUrl)，
   * schema 在 research-core/ports/financials.ts。
   * Fact-level asOf/retrievedAt 派生自 bundle 最新期；sourceTier 永远 'A'
   * (SEC 官方)。
   */
  financials: Fact(FinancialsBundleSchema).optional(),
});

// ===== Phase 1.x A-share specific facts (6 additional fields) =====

const ConsensusEpsRow = z.object({
  year: z.number().int(),
  value: z.number(),
});

const PeHistoricalPercentile = z.object({
  years5: z.number().min(0).max(100).optional(),
  years10: z.number().min(0).max(100).optional(),
});

const NorthboundFlowRow = z.object({
  // 'YYYY-MM-DD'. Not enforced as full datetime because A-share daily flow is
  // typically reported per trading day, not a precise timestamp.
  date: z.string(),
  // Net inflow in 亿元 (100M CNY). Positive = inflow, negative = outflow.
  hgt: z.number(),
  sgt: z.number(),
});

const LhbAppearanceRow = z.object({
  date: z.string(),
  // Reason as classified by 东财 (涨幅偏离 / 跌幅偏离 / 振幅偏大 / 换手率异常 etc).
  reason: z.string(),
  topBuySeats: z.array(z.string()).optional(),
  topSellSeats: z.array(z.string()).optional(),
});

const UnlockCalendarRow = z.object({
  date: z.string(),
  shares: z.number().positive(),
  // Market value in 亿元 at unlock date snapshot; optional because some
  // sources don't publish marked-to-market until closer to the date.
  marketValue: z.number().nonnegative().optional(),
  // E.g. '首发原股东限售股' / '股权激励' / '定增'.
  type: z.string(),
});

const ShareholderConcentration = z.object({
  // Sum of top 10 shareholders' stake (0-1, e.g. 0.62 = 62%).
  top10Ratio: z.number().min(0).max(1),
  institutionRatio: z.number().min(0).max(1).optional(),
  northboundRatio: z.number().min(0).max(1).optional(),
  retailRatio: z.number().min(0).max(1).optional(),
});

export const AShareSpecificFacts = z.object({
  consensusEps: Fact(z.array(ConsensusEpsRow)).optional(),
  peHistoricalPercentile: Fact(PeHistoricalPercentile).optional(),
  northboundFlow: Fact(z.array(NorthboundFlowRow)).optional(),
  lhbAppearances: Fact(z.array(LhbAppearanceRow)).optional(),
  unlockCalendar: Fact(z.array(UnlockCalendarRow)).optional(),
  shareholderConcentration: Fact(ShareholderConcentration).optional(),
});

// ===== EvidencePackV2 envelope =====

// Named with EvidencePack prefix to disambiguate from the existing
// `DataAvailability` in analysis-result.ts (which is a per-section
// `{missingFields, reason}` shape used in structuredJson baseline §4.22).
// This one is per-pack and richer (complete/missing/fallbacks).
export const EvidencePackDataAvailability = z.object({
  // fact key names that were successfully populated
  complete: z.array(z.string()),
  // fact key names that couldn't be populated, with reason
  missing: z.array(
    z.object({
      field: z.string(),
      reason: z.string(),
    }),
  ),
  // fact keys that used a non-primary source. Each entry: which source we
  // wanted (from) vs which one we landed on (to), plus reason.
  fallbacks: z.array(
    z.object({
      field: z.string(),
      from: z.string(),
      to: z.string(),
      reason: z.string(),
    }),
  ),
});
export type EvidencePackDataAvailability = z.infer<
  typeof EvidencePackDataAvailability
>;

/**
 * v0.6 PRD §9.2 — `systemContext` is the single source of truth for the
 * plan-derived prompt constraints (cap / blocked claims / skipped slots /
 * disclaimer). Section prompt builder formats this block; it MUST NOT
 * re-derive blocked claims from plan/snapshot directly.
 */
export const EvidencePackSystemContextSkippedSlot = z.object({
  slot: z.string(),
  reason: z.string(),
  priority: z.enum(['critical', 'recommended', 'optional']).optional(),
  subjectInstrumentId: z.string().optional(),
});
export type EvidencePackSystemContextSkippedSlot = z.infer<
  typeof EvidencePackSystemContextSkippedSlot
>;

export const EvidencePackSystemContext = z.object({
  planId: z.string().optional(),
  snapshotId: z.string().optional(),
  confidenceCap: Confidence,
  minimumViable: z.boolean(),
  planDisclaimer: z.array(z.string()),
  blockedClaims: z.array(z.string()),
  degradedReasons: z.array(z.string()),
  skippedSlots: z.array(EvidencePackSystemContextSkippedSlot),
});
export type EvidencePackSystemContext = z.infer<
  typeof EvidencePackSystemContext
>;

/**
 * v0.6 PRD §12.3 — additive trace fields. Pre-v0.6 packs omit all of these.
 */
export const EvidencePackV2SnapshotFactMappingMode = z.enum([
  'fact',
  'dataAvailability',
  'traceOnly',
]);
export type EvidencePackV2SnapshotFactMappingMode = z.infer<
  typeof EvidencePackV2SnapshotFactMappingMode
>;

export const EvidencePackV2SnapshotFactMapping = z.object({
  snapshotField: z.string(),
  factKey: z.string().optional(),
  mode: EvidencePackV2SnapshotFactMappingMode,
  reason: z.string().optional(),
});
export type EvidencePackV2SnapshotFactMapping = z.infer<
  typeof EvidencePackV2SnapshotFactMapping
>;

export const EvidencePackV2Trace = z.object({
  toolCalls: z.number().int().nonnegative(),
  durationMs: z.number().nonnegative(),
  // USD cost; for HTTP-only tools this is the LLM portion only (typically 0
  // for v2 since the LLM doesn't see the builder phase).
  costUsd: z.number().nonnegative(),
  cacheHits: z.number().int().nonnegative().optional(),
  fallbacksTriggered: z.number().int().nonnegative().optional(),
  /** v0.6 PRD §12.3 — additive optional, populated by snapshot-backed wrapper. */
  snapshotId: z.string().optional(),
  planId: z.string().optional(),
  originCounts: z
    .object({
      fromSnapshot: z.number().int().nonnegative(),
      providerNative: z.number().int().nonnegative(),
    })
    .optional(),
  augmentedFactKeys: z.array(z.string()).optional(),
  snapshotFactMapping: z.array(EvidencePackV2SnapshotFactMapping).optional(),
});
export type EvidencePackV2Trace = z.infer<typeof EvidencePackV2Trace>;

/**
 * v0.6 — `market` widened from the CN-only literal to a closed enum so the
 * v0.6 snapshot-backed wrapper can produce v2 packs for US (and later HK/JP/
 * UK) under the planner-driven path. CN consumers continue to pass 'CN' and
 * see no behavioural change. The wire literal `schemaVersion: 'evidence-pack-v2'`
 * is intentionally retained — debate/legacy consumers route on it unchanged.
 */
export const EvidencePackMarket = z.enum(['CN', 'US', 'HK', 'JP', 'UK']);
export type EvidencePackMarket = z.infer<typeof EvidencePackMarket>;

/**
 * v0.7 C2 — normalized cross-subject comparison facts (PRD §9.5 follow-up).
 *
 * The normalized shape transposes facts to "by fact key → per subject";
 * cross-subject diffs (numeric delta or count tally) are pre-computed by
 * the wrapper so prompts can render a single sentence.
 *
 * - `bySubject`: stable subject order (mirrors snapshot.subjectBundles order)
 *   so section prompts can name subjects consistently.
 * - `facts.<key>`: per-fact-key Map(subjectId → FactOf<value>). Map is used
 *   over Record so consumers can iterate insertion order.
 * - `crossSubjectDiff`: pre-computed comparison sentences keyed by factKey;
 *   `diffNote` is the rendered string (e.g. "腾讯 PE 25 vs 阿里 PE 18，差异 7 点").
 *
 * Always emitted by the comparison wrapper.
 */
export const InstrumentRefLite = z.object({
  instrumentId: z.string().min(1),
  market: EvidencePackMarket,
  symbol: z.string().min(1),
});
export type InstrumentRefLite = z.infer<typeof InstrumentRefLite>;

export const CrossSubjectDiff = z.object({
  factKey: z.string().min(1),
  values: z.array(
    z.object({
      subjectId: z.string().min(1),
      value: z.unknown(),
    }),
  ),
  /** Pre-rendered comparison sentence (Chinese), optional when not derivable. */
  diffNote: z.string().optional(),
});
export type CrossSubjectDiff = z.infer<typeof CrossSubjectDiff>;

/**
 * Normalized comparison facts. `facts.<key>` is a `Record<subjectId, FactOf>`
 * (zod-friendly substitute for Map; insertion order is preserved by JS
 * objects for string keys since ES2015).
 */
export const NormalizedComparisonFacts = z.object({
  bySubject: z.array(InstrumentRefLite),
  facts: z.record(
    z.string().min(1),
    z.record(z.string().min(1), z.unknown()),
  ),
  crossSubjectDiff: z.array(CrossSubjectDiff).optional(),
});
export type NormalizedComparisonFacts = z.infer<typeof NormalizedComparisonFacts>;

// plan-v2 Wave 1 — pre-computed deterministic block (ratios + tech + flags + valuation)
export const ComputedFactsBlock = z.object({
  ratios: ComputedFinancialRatiosSchema.nullable(),
  technical: ComputedTechnicalIndicatorsSchema.nullable(),
  redFlags: z.array(RedFlagSchema),
  valuation: ComputedValuationSchema.nullable(),
  /** Peer comparison; null when caller did not supply peer metrics. */
  peerComparison: PeerComparisonSchema.nullable(),
  /** Per-metric historical context (PE/PB/PS/FCFYield); empty array OK. */
  historicalContext: z.array(HistoricalContextSchema),
  /** When any compute fn emitted a warning (missing input / unknown unit). */
  warnings: z
    .array(
      z.object({
        code: z.string(),
        metric: z.string(),
        detail: z.string(),
      }),
    )
    .default([]),
});
export type ComputedFactsBlock = z.infer<typeof ComputedFactsBlock>;

export const EvidencePackV2 = z.object({
  schemaVersion: z.literal('evidence-pack-v2'),
  // Normalized symbol, e.g. '600519.SS' / 'AAPL' / '0700.HK'.
  symbol: z.string().min(1),
  market: EvidencePackMarket,
  capturedAt: z.string().datetime(),
  facts: MinimalFacts.merge(AShareSpecificFacts),
  /**
   * v0.7 C2 — normalized cross-subject facts for comparison-mode packs.
   * Wrapper always populates this for comparison runs.
   */
  normalizedComparisonFacts: NormalizedComparisonFacts.optional(),
  dataAvailability: EvidencePackDataAvailability,
  citations: z.array(Citation),
  trace: EvidencePackV2Trace,
  /** v0.6 PRD §9.2 — additive optional, set by snapshot-backed wrapper. */
  systemContext: EvidencePackSystemContext.optional(),
  /**
   * plan-v2 Wave 1 — pre-computed numeric facts (ratios / indicators / red
   * flags) derived by the deterministic `compute/` layer from raw snapshot
   * data. When present, dimension prompts MUST quote these instead of asking
   * the LLM to recompute. Absent when source data is insufficient (e.g.
   * `bundle` empty / `history` < 20 bars). Provenance lives in the
   * citations[] of the underlying raw facts — no per-field stamping.
   */
  computedFacts: ComputedFactsBlock.optional(),
});
export type EvidencePackV2 = z.infer<typeof EvidencePackV2>;

// Union of all fact key names — handy when callers need to iterate fields
// or when constructing structuredJson.factReferences[].
export const EVIDENCE_PACK_V2_FACT_KEYS = [
  'quote',
  'marketCap',
  'currency',
  'pe',
  'profile',
  'latestFilingUrls',
  'recentNews',
  'consensusEps',
  'peHistoricalPercentile',
  'northboundFlow',
  'lhbAppearances',
  'unlockCalendar',
  'shareholderConcentration',
] as const;
export type EvidencePackV2FactKey = (typeof EVIDENCE_PACK_V2_FACT_KEYS)[number];
