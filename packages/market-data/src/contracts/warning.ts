import { z } from 'zod';
import { SourceType } from './source-document';

export const ResearchWarningCode = z.enum([
  'SOURCE_UNAVAILABLE',
  'RATE_LIMITED',
  'AUTH_REQUIRED',
  'SCRAPE_FAILED',
  'PARTIAL_DATA',
  'STALE_DATA',
  'UNSUPPORTED_MARKET',
  'INVALID_INSTRUMENT',
  'UNKNOWN',
]);
export type ResearchWarningCode = z.infer<typeof ResearchWarningCode>;

export const ResearchWarning = z.object({
  code: ResearchWarningCode,
  message: z.string(),
  provider: z.string().optional(),
  sourceType: SourceType.optional(),
  retryAfterMs: z.number().optional(),
  cause: z.string().optional(),
});
export type ResearchWarning = z.infer<typeof ResearchWarning>;
