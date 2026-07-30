/**
 * @bourse/analysis — plan-v2 Wave 3 D14 unified package.
 *
 * Absorbs the former @bourse/research-core (connectors / capability /
 * ports / contracts / util) AND @bourse/analysis (compute / dimensions /
 * personas / workflows / tools / primitives / markets / guardrails /
 * lifecycle / SSE event contracts) into a single workspace package.
 *
 * Dependency graph after merge: shared-types ← analysis ← apps/{api,mcp,web}.
 */

export const VERSION = '0.1.0' as const;

// ---- Research data layer (formerly @bourse/research-core) ----------
export * from '@bourse/market-data';
export * from './contracts';

// Explicit value+type re-exports for zod schemas that share name with their
// inferred type — required across package boundaries under isolatedModules.
export { QualityTier } from '@bourse/market-data';
// Daily Brief (docs/prd-daily-brief.md) — zod schemas 同名 value+type，跨包
// 需 explicit re-export（isolatedModules，同 QualityTier 模式）。
export { ChannelConfig, ChannelType, BriefPayload } from './contracts/brief-payload';
export {
  computeContentHash,
  computeBinaryContentHash,
  formatInstrumentId,
  isInstrumentIdFormat,
  markdownToPlainText,
  normalizeUrl,
  parseInstrumentId,
  parseYahooSymbol,
} from './util';
export type { ParsedInstrumentId, ParsedProviderSymbol } from './util';

// ---- Agent SDK (formerly @bourse/agent) ----------------------------
export * from './compute';
export * from './primitives';
export * from './dimensions';
export * from './personas';
export * from './workflows';
export * from './markets';
export * from './guardrails';
export * from './tools';
export * from './prompts';

// ---- Snapshot orchestration -----------------------------------------------
export {
  fetchSnapshot,
  type FetchSnapshotOptions,
} from './snapshot/fetch-snapshot';

export {
  defineMarketConfig,
  portToFetcher,
  STANDARD_RESEARCH_REQUIREMENTS,
  type DataRequirement,
  type ExtraFetcher,
  type FilingsFetcher,
  type FinancialsFetcher,
  type HistoryFetcher,
  type Market,
  type MarketConfig,
  type MarketConfigMap,
  type ProfileFetcher,
  type QuoteFetcher,
} from './snapshot/market-config';

export {
  projectForDimension,
  projectForFundamental,
  projectForGovernance,
  projectForIndustry,
  projectForPortfolio,
  projectForRisk,
  projectForScenario,
  projectForSentiment,
  projectForTechnical,
  projectForValuation,
  type DimensionFactView,
  type DimensionName,
} from './snapshot/fact-filter';

export {
  DataAvailabilitySchema,
  SnapshotCitationSchema,
  SnapshotMissingFieldSchema,
  SnapshotMissingReasonSchema,
  StockSnapshotMetaSchema,
  type ComputedFacts,
  type DataAvailability,
  type RawFacts,
  type SnapshotCitation,
  type SnapshotSourceMetadata,
  type SnapshotMissingField,
  type SnapshotMissingReason,
  type StockSnapshot,
} from './snapshot/types';

export {
  snapshotToEvidencePack,
  type ToEvidencePackOptions,
} from './snapshot/to-evidence-pack';
export {
  applyResearchCoverage,
  buildResearchCoverage,
  shouldSkipForCoverage,
  ResearchCoverageSchema,
  ResearchDimensionCoverageSchema,
  type ResearchCoverage,
  type ResearchDimensionCoverage,
  type ResearchCoverageStatus,
} from './snapshot/research-coverage';

// ---- Fixture evals --------------------------------------------------------
export * from './evals';
