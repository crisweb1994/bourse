/**
 * Compute layer · relative judgments (peer comparison + historical context).
 *
 * Plan-v2 §6.6 — LLM is most unreliable at relative claims ("PE is
 * elevated", "ROE beats peers"). We move these to deterministic compute
 * so the LLM only interprets.
 *
 * Two outputs:
 *   1. PeerComparison: subject's PE/PB/ROE/netMargin/revenueGrowthYoY
 *      vs peer set (median, rank percentile). Peers come from
 *      peer-table.ts; their metrics must be fetched by the caller and
 *      passed in.
 *   2. HistoricalContext: subject's PE/PB/PS/FCFYield trajectory
 *      (per-period series) and where the current value sits in the
 *      historical range (5y percentile, z-score).
 *
 * This module is intentionally fetch-agnostic: it takes metrics as
 * inputs, doesn't hit any I/O. The snapshot wrapper or apps/api is the
 * one that bulk-pulls peer quotes/financials and fans into here.
 */

import { z } from 'zod';
import { findPeerGroup, findSectorForSymbol, type PeerEntry } from './peer-table';

// ============================================================================
// Schema
// ============================================================================

const PeerMetricsSchema = z.object({
  pe: z.number().nullable(),
  pb: z.number().nullable(),
  roe: z.number().nullable(),
  netMargin: z.number().nullable(),
  revenueGrowthYoY: z.number().nullable(),
});
export type PeerMetrics = z.infer<typeof PeerMetricsSchema>;

const PeerComparisonRowSchema = z.object({
  symbol: z.string(),
  name: z.string(),
  market: z.enum(['US', 'CN', 'HK']),
  metrics: PeerMetricsSchema,
});
export type PeerComparisonRow = z.infer<typeof PeerComparisonRowSchema>;

const MetricVsPeerSchema = z.object({
  subject: z.number().nullable(),
  median: z.number().nullable(),
  rankPercentile: z.number().min(0).max(100).nullable(),
  peerCount: z.number().int().nonnegative(),
});
export type MetricVsPeer = z.infer<typeof MetricVsPeerSchema>;

export const PeerComparisonSchema = z.object({
  sector: z.string().nullable(),
  subjectSymbol: z.string(),
  peers: z.array(PeerComparisonRowSchema),
  subjectVsPeerMedian: z.object({
    pe: MetricVsPeerSchema,
    pb: MetricVsPeerSchema,
    roe: MetricVsPeerSchema,
    netMargin: MetricVsPeerSchema,
    revenueGrowthYoY: MetricVsPeerSchema,
  }),
});
export type PeerComparison = z.infer<typeof PeerComparisonSchema>;

export const HistoricalContextSchema = z.object({
  metric: z.enum(['pe', 'pb', 'ps', 'fcfYield']),
  current: z.number().nullable(),
  history: z.array(
    z.object({
      period: z.string(),
      value: z.number(),
    }),
  ),
  percentile5y: z.number().min(0).max(100).nullable(),
  zScore5y: z.number().nullable(),
});
export type HistoricalContext = z.infer<typeof HistoricalContextSchema>;

// ============================================================================
// Public API
// ============================================================================

export interface ComputePeerComparisonInput {
  subjectSymbol: string;
  subjectMarket: 'US' | 'CN' | 'HK';
  subjectSector: string | null | undefined;
  subjectMetrics: PeerMetrics;
  /**
   * Peer metrics looked up by the caller. The wrapper hands these in as a
   * Map keyed by symbol; missing peers are silently dropped. compute layer
   * does not fetch; that's a caller concern (apps/api orchestrates).
   */
  peerMetrics: Map<string, PeerMetrics>;
}

export function computePeerComparison(
  input: ComputePeerComparisonInput,
): PeerComparison | null {
  const sector =
    input.subjectSector?.trim() || findSectorForSymbol(input.subjectMarket, input.subjectSymbol);
  if (!sector) return null;

  const group = findPeerGroup(input.subjectMarket, sector);
  if (group.length === 0) return null;

  // Exclude the subject itself from peer set (in case it appears in table)
  const filteredGroup = group.filter(
    (e) => e.symbol.toUpperCase() !== input.subjectSymbol.toUpperCase(),
  );

  const peers: PeerComparisonRow[] = [];
  for (const entry of filteredGroup) {
    const metrics = input.peerMetrics.get(entry.symbol);
    if (!metrics) continue; // peer wasn't fetched
    peers.push({
      symbol: entry.symbol,
      name: entry.name,
      market: entry.market,
      metrics,
    });
  }

  return {
    sector,
    subjectSymbol: input.subjectSymbol,
    peers,
    subjectVsPeerMedian: {
      pe: rank(input.subjectMetrics.pe, peers.map((p) => p.metrics.pe)),
      pb: rank(input.subjectMetrics.pb, peers.map((p) => p.metrics.pb)),
      roe: rank(input.subjectMetrics.roe, peers.map((p) => p.metrics.roe)),
      netMargin: rank(
        input.subjectMetrics.netMargin,
        peers.map((p) => p.metrics.netMargin),
      ),
      revenueGrowthYoY: rank(
        input.subjectMetrics.revenueGrowthYoY,
        peers.map((p) => p.metrics.revenueGrowthYoY),
      ),
    },
  };
}

/** Look up the static peer list for a subject without computing metrics. */
export function listExpectedPeers(
  market: 'US' | 'CN' | 'HK',
  sector: string | null | undefined,
  subjectSymbol: string,
): readonly PeerEntry[] {
  const resolvedSector = sector ?? findSectorForSymbol(market, subjectSymbol);
  if (!resolvedSector) return [];
  return findPeerGroup(market, resolvedSector).filter(
    (e) => e.symbol.toUpperCase() !== subjectSymbol.toUpperCase(),
  );
}

// ----------------------------------------------------------------------------
// Historical context
// ----------------------------------------------------------------------------

export interface ComputeHistoricalContextInput {
  metric: 'pe' | 'pb' | 'ps' | 'fcfYield';
  current: number | null;
  /** Period → value, oldest first or newest first — we sort/dedupe inside. */
  history: Array<{ period: string; value: number }>;
}

export function computeHistoricalContext(
  input: ComputeHistoricalContextInput,
): HistoricalContext {
  const cleaned = input.history.filter(
    (h) => Number.isFinite(h.value) && h.value > 0,
  );

  if (cleaned.length === 0 || input.current === null) {
    return {
      metric: input.metric,
      current: input.current,
      history: cleaned,
      percentile5y: null,
      zScore5y: null,
    };
  }

  const values = cleaned.map((h) => h.value).sort((a, b) => a - b);

  // Percentile rank
  let belowCount = 0;
  for (const v of values) if (v < input.current) belowCount++;
  const percentile = (belowCount / values.length) * 100;

  // Z-score
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  const sd = Math.sqrt(variance);
  const zScore = sd > 0 ? (input.current - mean) / sd : null;

  return {
    metric: input.metric,
    current: input.current,
    history: cleaned,
    percentile5y: percentile,
    zScore5y: zScore,
  };
}

// ----------------------------------------------------------------------------
// Internals
// ----------------------------------------------------------------------------

function rank(subject: number | null, peers: (number | null)[]): MetricVsPeer {
  const valid = peers.filter((v): v is number => v !== null && Number.isFinite(v));
  if (valid.length === 0) {
    return { subject, median: null, rankPercentile: null, peerCount: 0 };
  }
  const sorted = [...valid].sort((a, b) => a - b);
  const median =
    sorted.length % 2 === 1
      ? sorted[(sorted.length - 1) / 2]!
      : (sorted[sorted.length / 2 - 1]! + sorted[sorted.length / 2]!) / 2;

  let rankPercentile: number | null = null;
  if (subject !== null && Number.isFinite(subject)) {
    let below = 0;
    for (const v of sorted) if (v < subject) below++;
    rankPercentile = (below / sorted.length) * 100;
  }
  return { subject, median, rankPercentile, peerCount: valid.length };
}
