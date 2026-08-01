import { z } from 'zod';
import type { ConnectorRunContext } from '../connectors/types';
import type { ResearchResult } from '../contracts/result';
import type { SourceResult } from '../contracts/source-result';
import { DecimalStringSchema } from '../contracts/scalars';

export const CorporateActionDataSetSchema = z.enum([
  'dividend',
  'split',
  'rights-issue',
  'placement',
  'buyback',
  'adjustment-factor',
]);
export type CorporateActionDataSet = z.infer<typeof CorporateActionDataSetSchema>;

export const CorporateActionSchema = z.object({
  id: z.string().min(1),
  instrumentId: z.string().min(1),
  type: z.enum(['DIVIDEND', 'SPLIT', 'RIGHTS_ISSUE', 'PLACEMENT', 'BUYBACK', 'ADJUSTMENT_FACTOR']),
  status: z.enum(['ANNOUNCED', 'CONFIRMED', 'COMPLETED', 'CANCELLED', 'UNKNOWN']),
  announcedAt: z.string().optional(),
  exDate: z.string().optional(),
  recordDate: z.string().optional(),
  paymentDate: z.string().optional(),
  effectiveDate: z.string().optional(),
  cashAmount: DecimalStringSchema.optional(),
  currency: z.string().length(3).optional(),
  ratioNumerator: DecimalStringSchema.optional(),
  ratioDenominator: DecimalStringSchema.optional(),
  price: DecimalStringSchema.optional(),
  sourceDocumentId: z.string().optional(),
});
export type CorporateAction = z.infer<typeof CorporateActionSchema>;

export interface CorporateActionsInput {
  instrumentId: string;
  dataSet: CorporateActionDataSet;
  from?: string;
  to?: string;
  limit?: number;
}

export interface ProviderCorporateActionsPort {
  listActions(
    input: CorporateActionsInput,
    ctx?: ConnectorRunContext,
  ): Promise<ResearchResult<CorporateAction[]>>;
}

export interface CorporateActionsPort {
  listActions(
    input: CorporateActionsInput,
    ctx?: ConnectorRunContext,
  ): Promise<SourceResult<CorporateAction[]>>;
}
