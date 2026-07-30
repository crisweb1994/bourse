import { z } from 'zod';
import type { ConnectorRunContext } from '../connectors/types';
import type { ResearchResult } from '../contracts/result';
import type { SourceResult } from '../contracts/source-result';

const DecimalStringSchema = z.string().regex(/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/);

export const MarketEventDataSetSchema = z.enum([
  'earnings-calendar',
  'earnings-guidance',
  'unlock',
  'lhb',
  'suspension',
  'price-limit',
  'index-rebalance',
  'regulatory-event',
]);
export type MarketEventDataSet = z.infer<typeof MarketEventDataSetSchema>;

const MarketEventBaseSchema = z.object({
  id: z.string().min(1),
  instrumentId: z.string().min(1),
  occurredAt: z.string().min(1),
  effectiveAt: z.string().optional(),
  title: z.string().min(1),
  status: z.enum(['SCHEDULED', 'CONFIRMED', 'COMPLETED', 'CANCELLED']).optional(),
  sourceDocumentId: z.string().optional(),
});

export const UnlockMarketEventSchema = MarketEventBaseSchema.extend({
  type: z.literal('UNLOCK'),
  shares: DecimalStringSchema,
  marketValue: DecimalStringSchema.optional(),
  currency: z.string().length(3).optional(),
  unlockType: z.string().min(1),
});

export const LhbMarketEventSchema = MarketEventBaseSchema.extend({
  type: z.literal('LHB'),
  reason: z.string().min(1),
  reasonCode: z.string().nullable().optional(),
  topBuySeatNames: z.array(z.string()),
  topSellSeatNames: z.array(z.string()),
  buyAmount: DecimalStringSchema.nullable().optional(),
  sellAmount: DecimalStringSchema.nullable().optional(),
  netAmount: DecimalStringSchema.nullable().optional(),
});

export const GenericMarketEventSchema = MarketEventBaseSchema.extend({
  type: z.enum([
    'EARNINGS_DATE',
    'EARNINGS_GUIDANCE',
    'EXPRESS_REPORT',
    'SUSPENSION',
    'RESUMPTION',
    'PRICE_LIMIT',
    'INDEX_REBALANCE',
    'REGULATORY_EVENT',
  ]),
  amount: DecimalStringSchema.optional(),
  shares: DecimalStringSchema.optional(),
  currency: z.string().length(3).optional(),
  tags: z.array(z.string()).optional(),
  attributes: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
});

export const MarketEventSchema = z.union([
  UnlockMarketEventSchema,
  LhbMarketEventSchema,
  GenericMarketEventSchema,
]);
export type MarketEvent = z.infer<typeof MarketEventSchema>;

export interface MarketEventsInput {
  instrumentId: string;
  dataSet: MarketEventDataSet;
  from?: string;
  to?: string;
  limit?: number;
}

export interface ProviderMarketEventsPort {
  listEvents(
    input: MarketEventsInput,
    ctx?: ConnectorRunContext,
  ): Promise<ResearchResult<MarketEvent[]>>;
}

export interface MarketEventsPort {
  listEvents(
    input: MarketEventsInput,
    ctx?: ConnectorRunContext,
  ): Promise<SourceResult<MarketEvent[]>>;
}
