import { z } from 'zod';
import type { ResearchResult } from '../contracts/result';
import type { SourceResult } from '../contracts/source-result';
import type { ConnectorRunContext } from '../connectors/types';

export const MacroMarketSchema = z.enum(['US', 'CN', 'HK']);
export type MacroMarket = z.infer<typeof MacroMarketSchema>;

export const MacroCategorySchema = z.enum([
  'growth',
  'inflation',
  'employment',
  'money',
  'credit',
  'rates',
  'fx',
  'trade',
  'property',
  'fiscal',
]);
export type MacroCategory = z.infer<typeof MacroCategorySchema>;

export const MacroFrequencySchema = z.enum([
  'DAILY',
  'WEEKLY',
  'MONTHLY',
  'QUARTERLY',
  'ANNUAL',
]);
export type MacroFrequency = z.infer<typeof MacroFrequencySchema>;

const DecimalStringSchema = z.string().regex(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/);

export const MacroObservationSchema = z.object({
  market: MacroMarketSchema,
  /** Stable Bourse code, for example CN.CPI.YOY or US.POLICY_RATE. */
  seriesCode: z.string().min(1),
  category: MacroCategorySchema,
  name: z.string().min(1),
  value: DecimalStringSchema,
  unit: z.string().min(1),
  frequency: MacroFrequencySchema,
  periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  releasedAt: z.string().optional(),
  revisedAt: z.string().optional(),
  seasonalAdjustment: z.enum(['SA', 'NSA', 'UNKNOWN']).optional(),
  provider: z.string().min(1),
  providerSeriesId: z.string().min(1),
});
export type MacroObservation = z.infer<typeof MacroObservationSchema>;

export const MacroSnapshotSchema = z.object({
  market: MacroMarketSchema,
  observations: z.array(MacroObservationSchema),
});
export type MacroSnapshot = z.infer<typeof MacroSnapshotSchema>;

export interface MacroInput {
  market: MacroMarket;
  seriesCodes?: string[];
  categories?: MacroCategory[];
  from?: string;
  to?: string;
  limitPerSeries?: number;
  /** @deprecated Use limitPerSeries. Kept for one release during migration. */
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
