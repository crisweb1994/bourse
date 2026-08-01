import { z } from 'zod';
import type { ConnectorRunContext } from '../connectors/types';
import type { ResearchResult } from '../contracts/result';
import type { SourceResult } from '../contracts/source-result';
import { DecimalStringSchema } from '../contracts/scalars';

export const OwnershipDataSetSchema = z.enum([
  'shareholder-count',
  'stock-connect',
  'short-position',
  'institutional-position',
  'insider-transaction',
  'margin',
]);
export type OwnershipDataSet = z.infer<typeof OwnershipDataSetSchema>;

export const StockConnectObservationSchema = z.object({
  id: z.string().min(1),
  instrumentId: z.string().min(1),
  kind: z.literal('STOCK_CONNECT'),
  asOf: z.string().min(1),
  shanghaiNetFlow: DecimalStringSchema,
  shenzhenNetFlow: DecimalStringSchema,
  flowUnit: z.literal('CNY_100M'),
  holdingShares: DecimalStringSchema.nullable().optional(),
  holdingMarketValue: DecimalStringSchema.nullable().optional(),
  holdingPercentOfFloat: DecimalStringSchema.nullable().optional(),
  sourceDocumentId: z.string().optional(),
});

export const StockConnectHoldingObservationSchema = z.object({
  id: z.string().min(1),
  instrumentId: z.string().min(1),
  kind: z.literal('STOCK_CONNECT_HOLDING'),
  asOf: z.string().min(1),
  holdingShares: DecimalStringSchema,
  holdingPercentOfFloat: DecimalStringSchema.nullable().optional(),
  exchange: z.string().optional(),
  sourceDocumentId: z.string().optional(),
});

export const ShareholderCountObservationSchema = z.object({
  id: z.string().min(1),
  instrumentId: z.string().min(1),
  kind: z.literal('SHAREHOLDER_COUNT'),
  asOf: z.string().min(1),
  holderCount: z.number().int().nonnegative(),
  holderCountChange: z.number().int().nullable().optional(),
  holderCountChangePercent: DecimalStringSchema.nullable().optional(),
  averageHoldingAmount: DecimalStringSchema.nullable().optional(),
  averageHoldingShares: DecimalStringSchema.nullable().optional(),
  concentrationLabel: z.string().nullable().optional(),
  sourceDocumentId: z.string().optional(),
});

export const PositionObservationSchema = z.object({
  id: z.string().min(1),
  instrumentId: z.string().min(1),
  kind: z.enum(['SHORT_POSITION', 'INSTITUTIONAL_POSITION', 'INSIDER_TRANSACTION', 'MARGIN']),
  asOf: z.string().min(1),
  holderName: z.string().optional(),
  direction: z.enum(['BUY', 'SELL', 'LONG', 'SHORT', 'NET']).optional(),
  value: DecimalStringSchema,
  unit: z.enum(['shares', 'holders', 'percent', 'currency']),
  currency: z.string().length(3).optional(),
  periodStart: z.string().optional(),
  periodEnd: z.string().optional(),
  sourceDocumentId: z.string().optional(),
});

export const OwnershipObservationSchema = z.union([
  StockConnectObservationSchema,
  StockConnectHoldingObservationSchema,
  ShareholderCountObservationSchema,
  PositionObservationSchema,
]);
export type OwnershipObservation = z.infer<typeof OwnershipObservationSchema>;

export interface OwnershipInput {
  instrumentId: string;
  dataSet: OwnershipDataSet;
  from?: string;
  to?: string;
  limit?: number;
}

export interface ProviderOwnershipPort {
  listOwnership(
    input: OwnershipInput,
    ctx?: ConnectorRunContext,
  ): Promise<ResearchResult<OwnershipObservation[]>>;
}

export interface OwnershipPort {
  listOwnership(
    input: OwnershipInput,
    ctx?: ConnectorRunContext,
  ): Promise<SourceResult<OwnershipObservation[]>>;
}
