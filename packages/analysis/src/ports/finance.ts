import { z } from 'zod';
import type { InstrumentRef } from '../contracts/instrument';
import type { ResearchResult } from '../contracts/result';
import type { ConnectorRunContext } from '../connectors/types';

export interface QuoteInput {
  instrumentId: string;
}

/**
 * v0.8 C1 — Consensus EPS bundle. Sell-side analyst forecast EPS for
 * forward years; primary source for CN is Eastmoney's
 * `RPT_RES_CONFORECASTPREDATA` row family. Optional `perAnalyst` allows
 * future connectors to surface broker-level breakdown when available.
 *
 * Schema-first (zod) per packages/agent CLAUDE.md §2.11; this is a public
 * cross-package contract consumed by EvidencePackV2.
 */
export const ConsensusEpsRowSchema = z.object({
  year: z.number().int(),
  value: z.number(),
});
export type ConsensusEpsRow = z.infer<typeof ConsensusEpsRowSchema>;

export const ConsensusEpsPerAnalystSchema = z.object({
  analyst: z.string(),
  eps: z.number(),
  asOf: z.string().datetime(),
});
export type ConsensusEpsPerAnalyst = z.infer<typeof ConsensusEpsPerAnalystSchema>;

export const ConsensusEpsBundleSchema = z.object({
  /** Mean EPS across analysts for the nearest forward year. */
  avgEps: z.number(),
  /** Number of contributing analysts (0 when source doesn't publish). */
  analystCount: z.number().int().nonnegative(),
  /** ISO timestamp of the most recent forecast revision. */
  asOf: z.string().datetime(),
  /** Forward-year forecasts when source publishes multiple years. */
  forecasts: z.array(ConsensusEpsRowSchema),
  /** Optional broker-level breakdown. */
  perAnalyst: z.array(ConsensusEpsPerAnalystSchema).optional(),
});
export type ConsensusEpsBundle = z.infer<typeof ConsensusEpsBundleSchema>;

export interface ConsensusEpsInput {
  instrumentId: string;
}

export const EarningsConsensusEstimateSchema = z.object({
  metricCode: z.enum(['epsBasic', 'revenue']),
  periodEndOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  periodType: z.enum(['QUARTER', 'FY']),
  value: z.string().regex(/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/),
  unit: z.enum(['per_share', 'currency']),
  currency: z.string().length(3),
  analystCount: z.number().int().nonnegative().optional(),
});
export type EarningsConsensusEstimate = z.infer<typeof EarningsConsensusEstimateSchema>;

export const EarningsConsensusBundleSchema = z.object({
  asOf: z.string().datetime(),
  estimates: z.array(EarningsConsensusEstimateSchema),
});
export type EarningsConsensusBundle = z.infer<typeof EarningsConsensusBundleSchema>;

export interface Quote {
  instrument: InstrumentRef;
  price: number;
  change?: number;
  changePct?: number;
  volume?: number;
  currency: string;
  marketStatus?: 'OPEN' | 'CLOSED' | 'PRE_MARKET' | 'AFTER_HOURS' | 'UNKNOWN';
  timestamp: string;
  /** C1: optional intraday extensions; do not conflate with PriceBar */
  dayOpen?: number;
  dayHigh?: number;
  dayLow?: number;
  previousClose?: number;
  // Phase 3 C18: optional fundamentals some sources bundle with quote
  // (notably CN tencent/eastmoney payloads). Yahoo leaves these unset.
  marketCap?: number; // instrument currency units; CN sources report 亿元
  peRatio?: number; // trailing PE; null/missing → undefined
  // plan-v2 Wave 1.4 — extended CN quote payload (tencent 88-field, 28 used).
  // All optional; Yahoo / SEC sources leave them unset. Units:
  //   floatMarketCap: same as marketCap (instrument currency, CN: 亿元)
  //   sharesTotal / sharesFloat: 亿股 for CN sources, raw share count for US
  //   week52High / week52Low: instrument currency
  //   turnoverRate / amplitude: decimal fractions (0.0-1.0+), NOT percentages
  //   volumeRatio: ratio (1.0 = normal day's volume)
  //   bidAskRatio: signed decimal (-1.0..+1.0), >0 buy pressure
  //   turnover: 成交额 in instrument currency (CN: 元)
  pbRatio?: number; // 市净率
  floatMarketCap?: number; // 流通市值 (CN: 亿元)
  sharesTotal?: number; // 总股本 (CN: 亿股)
  sharesFloat?: number; // 流通股本 (CN: 亿股)
  week52High?: number;
  week52Low?: number;
  turnoverRate?: number; // 换手率 (decimal fraction; 0.05 = 5%)
  amplitude?: number; // 振幅 (decimal fraction)
  volumeRatio?: number; // 量比 (1.0 = par with 5d avg)
  bidAskRatio?: number; // 委比 (-1..+1)
  turnover?: number; // 成交额 in instrument currency
}

export interface HistoryInput {
  instrumentId: string;
  from: string;
  to: string;
  interval?: '1d' | '1h' | '5m' | '1m';
}

export interface PriceBar {
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  adjustedClose?: number;
  volume?: number;
}

export interface ProfileInput {
  instrumentId: string;
}

export interface CompanyProfile {
  instrument: InstrumentRef;
  description?: string;
  sector?: string;
  industry?: string;
  employees?: number;
  website?: string;
  marketCap?: number;
}

export interface FinancePort {
  getQuote(input: QuoteInput, ctx?: ConnectorRunContext): Promise<ResearchResult<Quote>>;
  getHistory(input: HistoryInput, ctx?: ConnectorRunContext): Promise<ResearchResult<PriceBar[]>>;
  getProfile?(input: ProfileInput, ctx?: ConnectorRunContext): Promise<ResearchResult<CompanyProfile>>;
  /**
   * v0.8 C1 — optional consensus EPS fetch. Optional so non-CN ports
   * (Yahoo / future US/HK) don't need to implement it. Returns `null`
   * when source publishes no forecast rows (e.g. micro-caps); returns a
   * `ResearchResult` wrapper when callers need warning provenance. The
   * snapshot builder treats `null` as "not available" silently (no
   * warning unless connector emits one explicitly).
   */
  fetchConsensusEps?(
    input: ConsensusEpsInput,
    ctx?: ConnectorRunContext,
  ): Promise<ResearchResult<ConsensusEpsBundle | null>>;
  /** Earnings-card benchmark snapshots. Callers must persist the result
   * before the filing publication time; fetching after publication cannot be
   * used to reconstruct a pre-publication consensus. */
  fetchEarningsConsensus?(
    input: ConsensusEpsInput,
    ctx?: ConnectorRunContext,
  ): Promise<ResearchResult<EarningsConsensusBundle | null>>;
}
