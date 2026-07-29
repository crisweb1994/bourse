import { z } from 'zod';
import { SourceType } from './source-document';

export const ResearchWarningCode = z.enum([
  'FALLBACK_USED',
  'OFFICIAL_SOURCE_UNAVAILABLE',
  'SOURCE_UNAVAILABLE',
  'RATE_LIMITED',
  'AUTH_REQUIRED',
  'SCRAPE_FAILED',
  'PARTIAL_DATA',
  'STALE_DATA',
  'DATA_CONFLICT',
  'PARTIAL_COVERAGE',
  'LOW_QUALITY_SOURCE',
  'DELAYED_DATA',
  'MARKET_CLOSED',
  'MARKET_SESSION_UNKNOWN',
  'FIELD_DROPPED',
  'NORMALIZED_WITH_ASSUMPTION',
  'REDISTRIBUTION_LIMITED',
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
