/**
 * plan-v2 Wave 2 — StockSnapshot type.
 *
 * Replaces the entire planning-package snapshot model
 * (ResearchSnapshot + SubjectBundle + Quality + DegradedReason etc.)
 * with a single value type. Caller fetches once, dimensions read
 * filtered views — no compiler, no plan, no audit log.
 *
 * Shape mirrors plan-v2 §8 StockSnapshotSchema. Computed facts live on
 * the same object so consumers see one source of truth.
 */

import { z } from 'zod';
import type {
  FilingSummary,
  FinancialsBundle,
  CompanyProfile,
  CorporateAction,
  EarningsConsensusBundle,
  MacroSnapshot,
  MarketEvent,
  OwnershipObservation,
  PriceBar,
  Quote,
} from '@bourse/market-data';
import {
  ComputedFinancialRatiosSchema,
  ComputedTechnicalIndicatorsSchema,
  ComputedValuationSchema,
  HistoricalContextSchema,
  PeerComparisonSchema,
  RedFlagSchema,
} from '../compute';
import type {
  ComputedFinancialRatios,
  ComputedTechnicalIndicators,
  ComputedValuation,
  HistoricalContext,
  PeerComparison,
  RedFlag,
} from '../compute';

// ----------------------------------------------------------------------------
// Data availability — first-class structured surface, not a string
// ----------------------------------------------------------------------------

export const SnapshotMissingReasonSchema = z.enum([
  'connector_error',
  'no_data',
  'invalid_data',
  'rate_limited',
  'auth_required',
  'not_implemented',
  'timeout',
  'not_configured',
]);
export type SnapshotMissingReason = z.infer<typeof SnapshotMissingReasonSchema>;

export const SnapshotMissingFieldSchema = z.object({
  field: z.string(),
  reason: SnapshotMissingReasonSchema,
  detail: z.string().optional(),
});
export type SnapshotMissingField = z.infer<typeof SnapshotMissingFieldSchema>;

export const DataAvailabilitySchema = z.object({
  available: z.array(z.string()),
  missing: z.array(SnapshotMissingFieldSchema),
  warnings: z.array(z.string()),
});
export type DataAvailability = z.infer<typeof DataAvailabilitySchema>;

// ----------------------------------------------------------------------------
// Citation (pack-level provenance per plan §1.2 invariant #4)
// ----------------------------------------------------------------------------

export const SnapshotCitationSchema = z.object({
  factKey: z.string(),
  title: z.string(),
  url: z.string().url(),
  retrievedAt: z.string().datetime(),
  asOf: z.string().optional(),
  provider: z.string().optional(),
  sourceType: z.string().optional(),
  qualityTier: z.enum(['A', 'B', 'C', 'D', 'E']).optional(),
});
export type SnapshotCitation = z.infer<typeof SnapshotCitationSchema>;

/** Connector metadata retained at the snapshot boundary for UI/debugging. */
export interface SnapshotSourceMetadata {
  freshness: Array<{
    provider: string;
    asOf: string;
    retrievedAt: string;
    stale: boolean;
    ttlMs?: number;
    reason?: string;
  }>;
  warnings: Array<{
    code: string;
    message: string;
    provider?: string;
    cause?: string;
  }>;
  trace?: unknown;
  cost?: unknown;
}

// ----------------------------------------------------------------------------
// StockSnapshot — the value all dimensions read
// ----------------------------------------------------------------------------

export interface RawFacts {
  quote: Quote | null;
  history: PriceBar[] | null;
  profile: CompanyProfile | null;
  financials: FinancialsBundle | null;
  filings: FilingSummary[] | null;
  consensusEps: EarningsConsensusBundle | null;
  northboundFlow: OwnershipObservation[] | null;
  lhb: MarketEvent[] | null;
  unlockCalendar: MarketEvent[] | null;
  shareholders: OwnershipObservation[] | null;
  corporateActions?: CorporateAction[] | null;
  ownership?: OwnershipObservation[] | null;
  marketEvents?: MarketEvent[] | null;
  webSearch: unknown | null;
  macro: MacroSnapshot | null;
}

export interface ComputedFacts {
  financialRatios: ComputedFinancialRatios | null;
  technicalIndicators: ComputedTechnicalIndicators | null;
  redFlags: RedFlag[];
  valuation: ComputedValuation | null;
  peerComparison: PeerComparison | null;
  historicalContext: HistoricalContext[];
}

export interface StockSnapshot {
  symbol: string;
  market: 'US' | 'CN' | 'HK';
  capturedAt: string; // ISO datetime
  rawFacts: RawFacts;
  computedFacts: ComputedFacts;
  citations: SnapshotCitation[];
  dataAvailability: DataAvailability;
  sourceMetadata?: Partial<Record<keyof RawFacts, SnapshotSourceMetadata>>;
}

// Convenience zod for the parts that don't depend on cross-package types.
// (Full schema parse isn't needed today; tests use TS shape checks.)
export const StockSnapshotMetaSchema = z.object({
  symbol: z.string(),
  market: z.enum(['US', 'CN', 'HK']),
  capturedAt: z.string().datetime(),
  dataAvailability: DataAvailabilitySchema,
  citations: z.array(SnapshotCitationSchema),
  computedFacts: z.object({
    financialRatios: ComputedFinancialRatiosSchema.nullable(),
    technicalIndicators: ComputedTechnicalIndicatorsSchema.nullable(),
    redFlags: z.array(RedFlagSchema),
    valuation: ComputedValuationSchema.nullable(),
    peerComparison: PeerComparisonSchema.nullable(),
    historicalContext: z.array(HistoricalContextSchema),
  }),
});
