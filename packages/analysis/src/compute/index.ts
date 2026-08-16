/**
 * Compute layer (Wave 1 / plan-v2).
 *
 * Deterministic TypeScript computations consumed by LLM prompts. Lives in
 * @bourse/analysis for Wave 1; moves to @bourse/analysis in Wave 3.
 *
 * Inputs come from research-core connectors (`FinancialsBundle`, `Quote`, ...);
 * outputs are injected into EvidencePack prompt blocks so the LLM can quote
 * pre-computed numbers instead of doing math.
 */

export {
  computeFinancialRatios,
  type ComputeFinancialRatiosInput,
  type ComputeFinancialRatiosResult,
} from './financial-ratios';

export {
  computeTechnicalIndicators,
  ComputedTechnicalIndicatorsSchema,
  type ComputedTechnicalIndicators,
  type ComputeTechnicalInput,
  type ComputeTechnicalResult,
} from './technical-indicators';

export {
  derivePriceSeries,
  smaPoints,
  ChartPricePointSchema,
  PriceSeriesBarSchema,
  PriceSeriesBlockSchema,
  PriceSeriesBasis,
  MAX_PRICE_SERIES_BARS,
  MIN_BARS_FOR_WEEK52,
  type ChartPricePoint,
  type PriceSeriesBar,
  type PriceSeriesBlock,
  type PriceSeriesBasis as PriceSeriesBasisType,
} from './chart-series';

export { detectRedFlags, type DetectRedFlagsInput } from './red-flags';

export {
  computeValuation,
  ComputedValuationSchema,
  type ComputedValuation,
  type ComputeValuationInput,
  type ComputeValuationResult,
} from './valuation-helpers';

export {
  computeHistoricalContext,
  computePeerComparison,
  listExpectedPeers,
  HistoricalContextSchema,
  PeerComparisonSchema,
  type ComputeHistoricalContextInput,
  type ComputePeerComparisonInput,
  type HistoricalContext,
  type MetricVsPeer,
  type PeerComparison,
  type PeerComparisonRow,
  type PeerMetrics,
} from './relative';

export {
  findPeerGroup,
  findSectorForSymbol,
  PEER_TABLE,
  type PeerEntry,
} from './peer-table';

export {
  currencyForMarket,
  normalize,
  normalizeCurrency,
  unitMultiplier,
} from './units';

export {
  locateSourceSpan,
  type EarningsDerivationText,
} from './earnings-verify';

export { comparableIdentity } from './earnings-reconcile';

export { attachComparisons, computePeriodComparison } from './earnings-diff';

export {
  projectStructuredEarnings,
  type CandidateSummary,
  type ExpectedEarningsPeriodType,
  type PendingReason,
  type RejectedCandidate,
  type SelectionDiagnostics,
  type StructuredEarningsMarket,
  type StructuredEarningsSelection,
  type StructuredEarningsSelectionInput,
} from './structured-earnings-selector';

export {
  sectionizeFilingText,
  selectRelevantFilingSections,
  type FilingSection,
} from './earnings-sections';

export {
  ComputedFinancialRatiosSchema,
  ComputeWarningCodeSchema,
  PeriodTrendSchema,
  RedFlagCategorySchema,
  RedFlagSchema,
  RedFlagSeveritySchema,
  type ComputedFinancialRatios,
  type ComputeWarning,
  type ComputeWarningCode,
  type PeriodTrend,
  type RedFlag,
  type RedFlagCategory,
  type RedFlagSeverity,
} from './types';
