import { z } from 'zod';

/** Stable failure codes used by routing decisions and source health tracking. */
export const SourceFailureCodeSchema = z.enum([
  'UNSUPPORTED_CAPABILITY',
  'UNSUPPORTED_DATASET',
  'UNSUPPORTED_SERIES',
  'UNSUPPORTED_MARKET',
  'UNSUPPORTED_SECURITY_TYPE',
  'UNSUPPORTED_INTERVAL',
  'UNSUPPORTED_REQUEST',
  'AUTH_REQUIRED',
  'AUTH_INVALID',
  'PERMISSION_DENIED',
  'RATE_LIMITED',
  'TIMEOUT',
  'ABORTED',
  'NETWORK_ERROR',
  'SOURCE_UNAVAILABLE',
  'EMPTY_RESPONSE',
  'INVALID_PAYLOAD',
  'NORMALIZATION_FAILED',
  'VALIDATION_FAILED',
  'CONFIG_MISSING',
  'CONFIG_INVALID',
  'REDISTRIBUTION_FORBIDDEN',
  'CIRCUIT_OPEN',
  'CACHE_ONLY_MISS',
]);
export type SourceFailureCode = z.infer<typeof SourceFailureCodeSchema>;

export interface SourceError {
  code: SourceFailureCode;
  message: string;
  retryAfterMs?: number;
}

export type SourceSkipCode =
  | 'DISABLED'
  | 'AUTH_UNAVAILABLE'
  | 'POLICY_DISABLED'
  | 'CIRCUIT_OPEN'
  | 'RATE_LIMITED'
  | 'UNSUPPORTED';
