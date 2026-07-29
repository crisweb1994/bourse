import type { ResearchWarning } from '../contracts/warning';
import type { SourceError } from '../contracts/errors';
import type { SourceResult, RoutedResult, SourceAttempt } from '../contracts/source-result';
import type { Capability } from '../contracts/source';
import { cacheKey } from '../cache/keys';
import { decideCache } from '../cache/cache-decision';
import type { CachePort } from '../ports/cache';
import type { SourceRequestContext } from '../ports/request-context';
import { InMemorySourceHealth } from '../sources/health';
import { InMemoryRateLimiter } from '../sources/rate-limit';
import type { SourceInstance } from '../sources/plugin';
import { DefaultInstrumentResolver, type InstrumentResolver } from '../sources/resolver';
import { CapabilityPlanner, type RouteRequest } from './planner';
import { RoutingPolicies, type RoutingPolicy } from './policy';

export type SourceOperation<T> = (
  source: SourceInstance,
  context: SourceRequestContext,
) => Promise<SourceResult<T>>;

export interface RouterOptions {
  defaultTimeoutMs?: number;
  now?: () => Date;
  resolver?: InstrumentResolver;
}

export interface RouterFetchOptions<T> {
  merge?: (results: readonly SourceResult<T>[]) => T | null;
}

export class CapabilityRouter {
  private readonly now: () => Date;
  private readonly defaultTimeoutMs: number;
  private readonly resolver: InstrumentResolver;

  constructor(
    private readonly planner: CapabilityPlanner,
    private readonly policies: RoutingPolicies,
    private readonly health: InMemorySourceHealth,
    private readonly rateLimiter: InMemoryRateLimiter,
    private readonly cache: CachePort,
    options: RouterOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 5_000;
    this.resolver = options.resolver ?? new DefaultInstrumentResolver();
  }

  async fetch<T>(
    request: RouteRequest,
    operation: SourceOperation<T>,
    options: RouterFetchOptions<T> = {},
  ): Promise<RoutedResult<T>> {
    const policy = this.policies.find(request.capability, request.market);
    if (!policy) return failed([], {
      code: 'UNSUPPORTED_MARKET',
      message: `No routing policy for ${request.capability} in ${request.market}.`,
    });

    const planned = this.planner.plan(request, policy);
    const attempts: SourceAttempt[] = [];
    let lastError: SourceError | undefined;
    let stale: { result: SourceResult<T>; attempt: SourceAttempt; allowed: boolean } | undefined;
    const successful: Array<{ result: SourceResult<T>; authority: string }> = [];

    for (const candidate of planned) {
      const sourceId = candidate.instance.manifest.id;
      if (candidate.skipReason) {
        attempts.push({ sourceId, capability: request.capability, outcome: 'skipped', cache: 'bypass', reasonCode: candidate.skipReason });
        continue;
      }
      const resolvedInstrument = request.instrumentId
        ? this.resolver.resolve({
            instrumentId: request.instrumentId,
            sourceId,
            capability: request.capability,
          })
        : undefined;
      if (request.instrumentId && !resolvedInstrument) {
        attempts.push({ sourceId, capability: request.capability, outcome: 'skipped', cache: 'bypass', reasonCode: 'UNSUPPORTED' });
        lastError = { code: 'UNSUPPORTED_REQUEST', message: `Unable to resolve ${request.instrumentId} for ${sourceId}.` };
        continue;
      }
      if (!this.rateLimiter.tryAcquire(sourceId, candidate.instance.manifest.rateLimit)) {
        attempts.push({ sourceId, capability: request.capability, outcome: 'skipped', cache: 'bypass', reasonCode: 'RATE_LIMITED' });
        lastError = { code: 'RATE_LIMITED', message: `${sourceId} rate limit is exhausted.` };
        continue;
      }

      const cacheScope = request.credentialScope === 'public'
        ? candidate.instance.credentialScope
        : request.credentialScope;
      const decision = decideCache({ capability: candidate.spec, credentialScope: cacheScope });
      const key = decision.readScope === 'none' ? undefined : cacheKey({
        sourceId,
        capability: request.capability,
        scope: decision.readScope,
        input: request.input,
      });
      if (key) {
        const cached = await this.cache.get<SourceResult<T>>(key);
        if (cached && !cached.stale) {
          attempts.push({ sourceId, capability: request.capability, outcome: 'hit', cache: 'hit' });
          if (policy.strategy !== 'merge') return success(cached.value, attempts, policy, candidate.spec.authority);
          successful.push({ result: cached.value, authority: candidate.spec.authority });
          continue;
        }
        if (cached?.stale) {
          stale = {
            result: cached.value,
            attempt: { sourceId, capability: request.capability, outcome: 'hit', cache: 'stale' },
            allowed: policy.allowStaleIfError ?? candidate.spec.allowStaleIfError ?? false,
          };
        }
      }

      const startedAt = this.now().getTime();
      const context: SourceRequestContext = {
        ...(request.signal ? { signal: request.signal } : {}),
        timeoutMs: request.timeoutMs ?? this.defaultTimeoutMs,
        credentialScope: candidate.instance.credentialScope,
        traceId: request.traceId ?? `${request.capability}:${startedAt}`,
        now: this.now,
        ...(resolvedInstrument ? { resolvedInstrument } : {}),
      };
      try {
        const result = await operation(candidate.instance, context);
        const latencyMs = this.now().getTime() - startedAt;
        const reasonCode = result.status === 'ok' ? undefined : result.error?.code;
        attempts.push({
          sourceId,
          capability: request.capability,
          outcome: result.status === 'ok' ? 'hit' : result.status,
          cache: 'miss',
          latencyMs,
          ...(reasonCode ? { reasonCode } : {}),
        });
        if (result.status === 'ok') {
          this.health.recordSuccess(sourceId);
          if (key && decision.writeScope !== 'none') {
            await this.cache.set(key, result, decision.ttlMs, decision.staleTtlMs);
          }
          if (policy.strategy !== 'merge') return success(result, attempts, policy, candidate.spec.authority);
          successful.push({ result, authority: candidate.spec.authority });
          continue;
        }
        if (result.status === 'failed' && result.error) {
          lastError = result.error;
          if (countsTowardCircuit(result.error.code)) this.health.recordFailure(sourceId, result.error.code);
        }
      } catch (error) {
        const failure: SourceError = { code: 'SOURCE_UNAVAILABLE', message: error instanceof Error ? error.message : String(error) };
        attempts.push({ sourceId, capability: request.capability, outcome: 'failed', cache: 'miss', latencyMs: this.now().getTime() - startedAt, reasonCode: failure.code });
        this.health.recordFailure(sourceId, failure.code);
        lastError = failure;
      } finally {
        this.rateLimiter.release(sourceId);
      }
    }

    if (successful.length > 0) {
      const data = options.merge?.(successful.map((item) => item.result)) ?? successful[0]!.result.data;
      if (data !== null) {
        const sources = successful.map((item) => item.result.sourceId);
        const hadFailure = attempts.some((attempt) => attempt.outcome === 'failed' || attempt.outcome === 'empty');
        return {
          status: hadFailure ? 'partial' : 'ok',
          data,
          mergedSources: sources,
          citations: dedupe(successful.flatMap((item) => item.result.citations)),
          freshness: successful.flatMap((item) => item.result.freshness),
          warnings: successful.flatMap((item) => item.result.warnings),
          attempts,
        };
      }
    }

    if (stale?.allowed) {
      return {
        status: 'partial',
        data: stale.result.data as T,
        selectedSource: stale.result.sourceId,
        citations: stale.result.citations,
        freshness: stale.result.freshness,
        warnings: [...stale.result.warnings, warning('STALE_DATA', 'Returning stale cached data after all live sources failed.', stale.result.sourceId)],
        attempts: [...attempts, stale.attempt],
      };
    }
    return failed(attempts, lastError ?? { code: 'EMPTY_RESPONSE', message: 'No source returned usable data.' });
  }
}

function success<T>(result: SourceResult<T>, attempts: SourceAttempt[], policy: RoutingPolicy, authority: string): RoutedResult<T> {
  if (result.status !== 'ok') return failed(attempts, result.error ?? { code: 'EMPTY_RESPONSE', message: 'Source returned no data.' });
  const usedFallback = attempts.some((attempt) => attempt.outcome === 'failed' || attempt.outcome === 'empty');
  const downgradedAuthority = policy.strategy === 'official-first' && authority !== 'regulator' && authority !== 'exchange';
  const warnings = [
    ...result.warnings,
    ...(usedFallback ? [warning('FALLBACK_USED', `Used ${result.sourceId} after an earlier source was unavailable.`, result.sourceId)] : []),
    ...(downgradedAuthority ? [warning('OFFICIAL_SOURCE_UNAVAILABLE', `No official ${policy.capability} source was usable.`, result.sourceId)] : []),
  ];
  return {
    status: downgradedAuthority ? 'partial' : 'ok',
    data: result.data,
    selectedSource: result.sourceId,
    citations: result.citations,
    freshness: result.freshness,
    warnings,
    attempts,
  };
}

function failed<T>(attempts: SourceAttempt[], error: SourceError): RoutedResult<T> {
  return { status: error.code === 'EMPTY_RESPONSE' ? 'empty' : 'failed', data: null, citations: [], freshness: [], warnings: [], attempts, error };
}

function warning(code: ResearchWarning['code'], message: string, provider: string): ResearchWarning {
  return { code, message, provider };
}

function countsTowardCircuit(code: SourceError['code']): boolean {
  return ['RATE_LIMITED', 'TIMEOUT', 'NETWORK_ERROR', 'SOURCE_UNAVAILABLE', 'INVALID_PAYLOAD', 'NORMALIZATION_FAILED', 'VALIDATION_FAILED'].includes(code);
}

function dedupe<T extends { url?: string; provider: string }>(values: T[]): T[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = `${value.provider}:${value.url ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
