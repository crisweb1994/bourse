import { z } from 'zod';

export const DataFreshness = z.object({
  provider: z.string(),
  asOf: z.string(),
  retrievedAt: z.string(),
  stale: z.boolean(),
  ttlMs: z.number().optional(),
  reason: z.string().optional(),
});
export type DataFreshness = z.infer<typeof DataFreshness>;
