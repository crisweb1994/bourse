import { z } from 'zod';
import type { ResearchResult } from '../contracts/result';
import type { SourceResult } from '../contracts/source-result';
import type { ConnectorRunContext } from '../connectors/types';

export const MacroMarketSchema = z.enum(['US', 'CN', 'HK']);
export type MacroMarket = z.infer<typeof MacroMarketSchema>;

export const MacroIndicatorSchema = z.enum([
  'gdp_growth',
  'inflation',
  'unemployment',
  'policy_rate',
  'interbank_rate_3m',
  'government_bond_10y',
  'federal_debt',
  'exchange_rate',
]);
export type MacroIndicator = z.infer<typeof MacroIndicatorSchema>;

export const MacroFrequencySchema = z.enum(['DAILY', 'MONTHLY', 'ANNUAL']);
export type MacroFrequency = z.infer<typeof MacroFrequencySchema>;

export const MacroObservationSchema = z.object({
  indicator: MacroIndicatorSchema,
  value: z.number().finite(),
  unit: z.enum(['percent', 'local_currency_per_usd', 'usd']),
  period: z.string().regex(/^\d{4}(?:-\d{2}-\d{2})?$/),
  frequency: MacroFrequencySchema,
  provider: z.enum(['world-bank', 'fred', 'hkma', 'us-treasury']),
  seriesId: z.string().min(1),
});
export type MacroObservation = z.infer<typeof MacroObservationSchema>;

export const MacroSnapshotSchema = z.object({
  market: MacroMarketSchema,
  observations: z.array(MacroObservationSchema),
});
export type MacroSnapshot = z.infer<typeof MacroSnapshotSchema>;

export interface MacroInput {
  market: MacroMarket;
  /** Latest valid observations retained for each series. Defaults to 1. */
  lookback?: number;
}

export interface ProviderMacroPort {
  fetchMacro(
    input: MacroInput,
    ctx?: ConnectorRunContext,
  ): Promise<ResearchResult<MacroSnapshot>>;
}

export interface MacroPort {
  fetchMacro(
    input: MacroInput,
    ctx?: ConnectorRunContext,
  ): Promise<SourceResult<MacroSnapshot>>;
}
