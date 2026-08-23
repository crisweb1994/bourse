import { z } from 'zod';
import {
  EquityScreenerSnapshotSchema,
  ScreenerMetricSchema,
  ScreenerOperatorSchema,
  type EquityScreenerSnapshot,
  type ScreeningQuery,
} from '@bourse/shared-types';
import type { Market } from '@bourse/shared-types';
import type { SourceResult } from '../contracts/source-result';
import type { ConnectorRunContext } from '../connectors/types';

export const EquityScreenerDescriptorSchema = z
  .object({
    market: z.enum(['US', 'CN', 'HK']),
    metrics: z.array(
      z
        .object({
          metric: ScreenerMetricSchema,
          operators: z.array(ScreenerOperatorSchema).min(1),
        })
        .strict(),
    ),
    sortableMetrics: z.array(ScreenerMetricSchema),
    delay: z.enum(['realtime', 'delayed', 'eod']),
    universeLabel: z.string().min(1),
    universeRules: z.array(z.string().min(1)).min(1),
  })
  .strict();

export type EquityScreenerDescriptor = z.infer<
  typeof EquityScreenerDescriptorSchema
>;

export { EquityScreenerSnapshotSchema };
export type { EquityScreenerSnapshot };

export interface EquityScreenerPort {
  describe(
    market: Market,
    ctx?: ConnectorRunContext,
  ): Promise<SourceResult<EquityScreenerDescriptor>>;

  screen(
    query: ScreeningQuery,
    ctx?: ConnectorRunContext,
  ): Promise<SourceResult<EquityScreenerSnapshot>>;
}
