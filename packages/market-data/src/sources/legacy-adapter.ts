import type { ResearchResult } from '../contracts/result';
import type { SourceError } from '../contracts/errors';
import type { SourceResult } from '../contracts/source-result';
import type { ResearchWarning } from '../contracts/warning';

/** Temporary boundary while v1 connectors are migrated to SourceResult directly. */
export function adaptLegacyResult<T>(
  sourceId: string,
  result: ResearchResult<T>,
  usable: (data: T) => boolean,
): SourceResult<NonNullable<T>> {
  if (usable(result.data)) {
    return {
      status: 'ok',
      data: result.data as NonNullable<T>,
      sourceId,
      citations: result.citations,
      freshness: result.freshness,
      warnings: result.warnings,
    };
  }
  const error = sourceError(result.warnings);
  if (!error || isEmpty(result.warnings)) {
    return {
      status: 'empty',
      data: null,
      sourceId,
      citations: result.citations,
      freshness: result.freshness,
      warnings: result.warnings,
    };
  }
  return {
    status: 'failed',
    data: null,
    sourceId,
    citations: result.citations,
    freshness: result.freshness,
    warnings: result.warnings,
    error,
  };
}

export function unavailable<T>(sourceId: string, message: string): SourceResult<T> {
  return {
    status: 'failed',
    data: null,
    sourceId,
    citations: [],
    freshness: [],
    warnings: [{ code: 'SOURCE_UNAVAILABLE', message, provider: sourceId }],
    error: { code: 'UNSUPPORTED_CAPABILITY', message },
  };
}

function isEmpty(warnings: ResearchWarning[]): boolean {
  return warnings.length === 0 || warnings.every((warning) => warning.code === 'PARTIAL_DATA' || warning.code === 'STALE_DATA');
}

function sourceError(warnings: ResearchWarning[]): SourceError | undefined {
  const warning = warnings[0];
  if (!warning) return undefined;
  switch (warning.code) {
    case 'AUTH_REQUIRED': return { code: 'AUTH_REQUIRED', message: warning.message, retryAfterMs: warning.retryAfterMs };
    case 'RATE_LIMITED': return { code: 'RATE_LIMITED', message: warning.message, retryAfterMs: warning.retryAfterMs };
    case 'UNSUPPORTED_MARKET': return { code: 'UNSUPPORTED_MARKET', message: warning.message };
    case 'INVALID_INSTRUMENT': return { code: 'UNSUPPORTED_REQUEST', message: warning.message };
    case 'PARTIAL_DATA': return undefined;
    default: return { code: 'SOURCE_UNAVAILABLE', message: warning.message };
  }
}
