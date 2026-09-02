import { z } from 'zod';
import type { SourceResult } from '../contracts/source-result';

// KISS C6/G-12: a union with `| string` collapses to string — declare it as
// such instead of a fake enum.
export type InstrumentSearchMarket = string;

export const InstrumentSearchResultSchema = z.object({
  symbol: z.string().min(1),
  name: z.string(),
  market: z.string().min(1),
  exchange: z.string(),
  currency: z.string(),
  yahooSymbol: z.string().min(1),
});
export type InstrumentSearchResult = z.infer<typeof InstrumentSearchResultSchema>;
export const InstrumentSearchResultsSchema = z.array(InstrumentSearchResultSchema);

export interface ProviderInstrumentSearchPort {
  search(query: string, signal?: AbortSignal): Promise<InstrumentSearchResult[]>;
}

/** Canonical source-plugin port consumed by the capability router. */
export interface InstrumentSearchPort {
  search(query: string, signal?: AbortSignal): Promise<SourceResult<InstrumentSearchResult[]>>;
}
