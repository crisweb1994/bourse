import { z } from 'zod';
import { InstrumentRef } from '../contracts/instrument';
import type { ResearchResult } from '../contracts/result';
import type { SourceResult } from '../contracts/source-result';
import type { ConnectorRunContext } from '../connectors/types';

export interface QuoteInput {
  instrumentId: string;
}

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

const CanonicalTimestampSchema = z.string().refine(
  (value) => !Number.isNaN(Date.parse(value)),
  'Expected a parseable date or timestamp.',
);

export const QuoteSchema = z.object({
  instrument: InstrumentRef,
  price: z.number().finite(),
  change: z.number().finite().optional(),
  /** Percentage points: 1.42 means 1.42%, consistently across providers. */
  changePct: z.number().finite().optional(),
  /** Traded shares, never provider-specific lots. */
  volume: z.number().finite().nonnegative().optional(),
  currency: z.string().min(1),
  marketStatus: z.enum(['OPEN', 'CLOSED', 'PRE_MARKET', 'AFTER_HOURS', 'UNKNOWN']).optional(),
  timestamp: CanonicalTimestampSchema,
  /** C1: optional intraday extensions; do not conflate with PriceBar */
  dayOpen: z.number().finite().optional(),
  dayHigh: z.number().finite().optional(),
  dayLow: z.number().finite().optional(),
  previousClose: z.number().finite().optional(),
  // Phase 3 C18: optional fundamentals some sources bundle with quote
  // (notably CN tencent/eastmoney payloads). Yahoo leaves these unset.
  /** Instrument-currency base units (for example CNY yuan or USD dollars). */
  marketCap: z.number().finite().optional(),
  peRatio: z.number().finite().optional(),
  // plan-v2 Wave 1.4 — extended CN quote payload (tencent 88-field, 28 used).
  // All optional; Yahoo / SEC sources leave them unset. Units:
  //   floatMarketCap: instrument-currency base units
  //   sharesTotal / sharesFloat: shares
  //   week52High / week52Low: instrument currency
  //   turnoverRate / amplitude: decimal fractions (0.0-1.0+), NOT percentages
  //   volumeRatio: ratio (1.0 = normal day's volume)
  //   bidAskRatio: signed decimal (-1.0..+1.0), >0 buy pressure
  //   turnover: 成交额 in instrument currency (CN: 元)
  pbRatio: z.number().finite().optional(),
  floatMarketCap: z.number().finite().optional(),
  sharesTotal: z.number().finite().optional(),
  sharesFloat: z.number().finite().optional(),
  week52High: z.number().finite().optional(),
  week52Low: z.number().finite().optional(),
  turnoverRate: z.number().finite().optional(),
  amplitude: z.number().finite().optional(),
  volumeRatio: z.number().finite().optional(),
  bidAskRatio: z.number().finite().optional(),
  turnover: z.number().finite().optional(),
});
export type Quote = z.infer<typeof QuoteSchema>;

export interface HistoryInput {
  instrumentId: string;
  from: string;
  to: string;
  interval?: '1d' | '1h' | '5m' | '1m';
}

export const PriceBarSchema = z.object({
  timestamp: CanonicalTimestampSchema,
  open: z.number().finite(),
  high: z.number().finite(),
  low: z.number().finite(),
  close: z.number().finite(),
  adjustedClose: z.number().finite().optional(),
  volume: z.number().finite().nonnegative().optional(),
});
export type PriceBar = z.infer<typeof PriceBarSchema>;
export const PriceHistorySchema = z.array(PriceBarSchema);

export interface ProfileInput {
  instrumentId: string;
}

export const CompanyProfileSchema = z.object({
  instrument: InstrumentRef,
  description: z.string().optional(),
  sector: z.string().optional(),
  industry: z.string().optional(),
  employees: z.number().finite().nonnegative().optional(),
  website: z.string().optional(),
  marketCap: z.number().finite().optional(),
});
export type CompanyProfile = z.infer<typeof CompanyProfileSchema>;

/** A narrow profile-only port for authoritative fallback sources. */
export interface ProviderCompanyProfilePort {
  getProfile(
    input: ProfileInput,
    ctx?: ConnectorRunContext,
  ): Promise<ResearchResult<CompanyProfile>>;
}

export interface ProviderFinancePort {
  getQuote(input: QuoteInput, ctx?: ConnectorRunContext): Promise<ResearchResult<Quote>>;
  getHistory(input: HistoryInput, ctx?: ConnectorRunContext): Promise<ResearchResult<PriceBar[]>>;
  getProfile?(input: ProfileInput, ctx?: ConnectorRunContext): Promise<ResearchResult<CompanyProfile>>;
  /** Earnings-card benchmark snapshots. Callers must persist the result
   * before the filing publication time; fetching after publication cannot be
   * used to reconstruct a pre-publication consensus. */
  fetchEarningsConsensus?(
    input: ConsensusEpsInput,
    ctx?: ConnectorRunContext,
  ): Promise<ResearchResult<EarningsConsensusBundle | null>>;
}

/** Canonical source-plugin port consumed by the capability router. */
export interface CompanyProfilePort {
  getProfile(input: ProfileInput, ctx?: ConnectorRunContext): Promise<SourceResult<CompanyProfile>>;
}

/** Canonical source-plugin port consumed by the capability router. */
export interface FinancePort {
  getQuote(input: QuoteInput, ctx?: ConnectorRunContext): Promise<SourceResult<Quote>>;
  getHistory(input: HistoryInput, ctx?: ConnectorRunContext): Promise<SourceResult<PriceBar[]>>;
  getProfile?(input: ProfileInput, ctx?: ConnectorRunContext): Promise<SourceResult<CompanyProfile>>;
  fetchEarningsConsensus?(
    input: ConsensusEpsInput,
    ctx?: ConnectorRunContext,
  ): Promise<SourceResult<EarningsConsensusBundle>>;
}
