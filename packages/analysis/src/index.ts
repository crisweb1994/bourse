/**
 * @bourse/analysis — Analysis V2 workspace package.
 *
 * Owns the research contracts, evidence snapshot, deterministic compute,
 * the five fixed research dimensions, the comprehensive workflow and its
 * SSE event contracts, plus the tool/primitives layers under them.
 *
 * Dependency graph: shared-types ← analysis ← apps/{api,mcp,web}.
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
export * from './workflows';
export * from './markets';
export * from './guardrails';
export * from './tools';
export * from './prompts';
export * from './presets';

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
  projectForCompanyQuality,
  projectForIndustryPosition,
  projectForValuationScenarios,
  projectForRiskRegister,
  projectForMarketSignals,
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
