// plan-v2 Wave 3 D14: research-core + agent contracts merged into a single
// barrel. Research data layer types (left half) and LLM-facing types
// (right half) live side-by-side now.
export {
  DataFreshness,
  InstrumentRef,
  MarketCode,
  QualityTier,
  ResearchCitation,
  ResearchTrace,
  ResearchWarning,
  ResearchWarningCode,
  Sensitivity,
  SourceDocument,
  SourceType,
} from '@bourse/market-data';
export type {
  ResearchResult,
  ResearchSchemaVersion,
} from '@bourse/market-data';
export {
  RESEARCH_SCHEMA_VERSION,
  ResearchError,
  isMarketSupported,
  SUPPORTED_MARKETS_PHASE_1_4,
} from '@bourse/market-data';
export type { OrchestratorOptions } from '@bourse/market-data';

export * from './enums';
export * from './citation';
export * from './trace';
export * from './analysis-request';
export * from './analysis-result';
export * from './comprehensive-summary';
export * from './evidence-pack-v2';
export * from './sse-events';

// Daily Brief (docs/prd-daily-brief.md) — 定时行情简报契约
export * from './brief-payload';
export * from './earnings';
export * from './investor-relations';
