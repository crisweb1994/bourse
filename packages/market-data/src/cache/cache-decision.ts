import type { CapabilitySpec, CacheScope, RedistributionPolicy } from '../contracts/source';

export interface CacheDecision {
  readScope: CacheScope | 'none';
  writeScope: CacheScope | 'none';
  ttlMs: number;
  staleTtlMs: number;
  reason: string;
}

export function decideCache(input: {
  capability: CapabilitySpec;
  credentialScope: CacheScope;
  resultStatus?: 'ok' | 'partial' | 'empty' | 'failed';
}): CacheDecision {
  const redistribution: RedistributionPolicy = input.capability.redistribution;
  if (redistribution === 'no-store' || input.resultStatus === 'partial' || input.resultStatus === 'failed') {
    return { readScope: 'none', writeScope: 'none', ttlMs: 0, staleTtlMs: 0, reason: 'result or source policy is not cacheable' };
  }
  const scope = redistribution === 'public-cache-allowed' && input.credentialScope === 'public'
    ? 'public'
    : input.credentialScope;
  return {
    readScope: scope,
    writeScope: scope,
    ttlMs: input.capability.ttlMs,
    staleTtlMs: input.capability.allowStaleIfError ? input.capability.maxStaleMs ?? 0 : 0,
    reason: redistribution,
  };
}
