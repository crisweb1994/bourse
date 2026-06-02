import { z } from 'zod';

export const MarketCode = z.enum(['US', 'CN', 'HK', 'JP', 'UK']);
export type MarketCode = z.infer<typeof MarketCode>;

export const InstrumentRef = z.object({
  instrumentId: z.string(),
  market: MarketCode,
  symbol: z.string(),
  name: z.string().optional(),
  exchange: z.string().optional(),
  currency: z.string().optional(),
  aliases: z.array(z.string()).optional(),
  providerSymbols: z.record(z.string()).optional(),
});
export type InstrumentRef = z.infer<typeof InstrumentRef>;

export const SUPPORTED_MARKETS_PHASE_1_4: readonly MarketCode[] = ['US', 'CN', 'HK'] as const;

export function isMarketSupported(market: MarketCode): boolean {
  return SUPPORTED_MARKETS_PHASE_1_4.includes(market);
}
