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
import type { FilingSummary } from '../ports/filings';
import type { FinancialsBundle } from '../ports/financials';
import type { PriceBar, Quote } from '../ports/finance';
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
  'rate_limited',
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
});
export type SnapshotCitation = z.infer<typeof SnapshotCitationSchema>;

// ----------------------------------------------------------------------------
// StockSnapshot — the value all dimensions read
// ----------------------------------------------------------------------------

export interface RawFacts {
  quote: Quote | null;
  history: PriceBar[] | null;
  profile: Record<string, unknown> | null;
  financials: FinancialsBundle | null;
  filings: FilingSummary[] | null;
  consensusEps: unknown | null;
  northboundFlow: unknown | null;
  lhb: unknown | null;
  unlockCalendar: unknown | null;
  shareholders: unknown | null;
  webSearch: unknown | null;
  macro: unknown | null;
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
