import type { ResearchWarning } from '../contracts/warning';
import type { SourceError } from '../contracts/errors';
import type { SourceResult, RoutedResult, SourceAttempt } from '../contracts/source-result';
import type { Capability } from '../contracts/source';
import { cacheKey } from '../cache/keys';
import { decideCache } from '../cache/cache-decision';
import type { CachePort } from '../ports/cache';
import type { SourceRequestContext } from '../ports/request-context';
import {
  NOOP_MARKET_DATA_EVENT_SINK,
  type MarketDataEventSink,
} from '../observability/events';
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
  eventSink?: MarketDataEventSink;
}

export interface RouterFetchOptions<T> {
  merge?: (results: readonly SourceResult<T>[]) => T | null;
}

export class CapabilityRouter {
  private readonly now: () => Date;
  private readonly defaultTimeoutMs: number;
  private readonly resolver: InstrumentResolver;
  private readonly eventSink: MarketDataEventSink;

  constructor(
    private readonly planner: CapabilityPlanner,
    private readonly policies: RoutingPolicies,
    private readonly health: InMemorySourceHealth,
    private readonly rateLimiter: InMemoryRateLimiter,
    private readonly cache: CachePort,
    options: RouterOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    // The outer routing deadline must outlive built-in connector deadlines
    // (HKEX uses 12s and official macro sources use 8s).
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 15_000;
    this.resolver = options.resolver ?? new DefaultInstrumentResolver();
    this.eventSink = options.eventSink ?? NOOP_MARKET_DATA_EVENT_SINK;
  }

  async fetch<T>(
    request: RouteRequest,
    operation: SourceOperation<T>,
    options: RouterFetchOptions<T> = {},
  ): Promise<RoutedResult<T>> {
    const traceId = request.traceId ?? `${request.capability}:${this.now().getTime()}`;
    const policy = this.policies.find(request.capability, request.market);
    if (!policy) {
      this.eventSink.emit({ type: 'route.planned', traceId, capability: request.capability, market: request.market, candidates: [] });
      const code = !this.policies.hasMarket(request.market)
        ? 'UNSUPPORTED_MARKET'
        : !this.policies.hasCapability(request.capability)
          ? 'UNSUPPORTED_CAPABILITY'
          : 'UNSUPPORTED_REQUEST';
      return this.complete(request, traceId, failed([], {
        code,
        message: `No routing policy for ${request.capability} in ${request.market}.`,
      }));
    }

    const planned = this.planner.plan(request, policy);
    this.eventSink.emit({
      type: 'route.planned',
      traceId,
      capability: request.capability,
      market: request.market,
      candidates: planned.map((candidate) => candidate.instance.manifest.id),
    });
    const attempts: SourceAttempt[] = [];
    const recordAttempt = (attempt: SourceAttempt): void => {
      attempts.push(attempt);
      this.eventSink.emit({ type: 'source.attempted', traceId, attempt });
    };
    let lastError: SourceError | undefined;
    const sourceWarnings: ResearchWarning[] = [];
    let stale: { result: SourceResult<T>; attempt: SourceAttempt; allowed: boolean } | undefined;
    const successful: Array<{ result: SourceResult<T>; authority: string }> = [];

    if (planned.length === 0) {
      const code = this.planner.diagnoseUnsupported(request) ?? 'UNSUPPORTED_CAPABILITY';
      return this.complete(request, traceId, failed(attempts, {
        code,
        message: `No source supports ${request.capability} for the requested market, security type, and interval.`,
      }));
    }

    for (const candidate of planned) {
      const sourceId = candidate.instance.manifest.id;
      if (request.signal?.aborted) {
        return this.complete(request, traceId, failed(attempts, {
          code: 'ABORTED',
          message: 'Market-data request was aborted by the caller.',
        }));
      }
      if (candidate.skipReason) {
        recordAttempt({ sourceId, capability: request.capability, outcome: 'skipped', cache: 'bypass', reasonCode: candidate.skipReason });
        lastError = skipFailure(candidate.skipReason, sourceId);
        if (candidate.skipReason === 'AUTH_UNAVAILABLE') {
          sourceWarnings.push(warning('AUTH_REQUIRED', lastError.message, sourceId));
        }
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
        recordAttempt({ sourceId, capability: request.capability, outcome: 'skipped', cache: 'bypass', reasonCode: 'UNSUPPORTED' });
        lastError = { code: 'UNSUPPORTED_REQUEST', message: `Unable to resolve ${request.instrumentId} for ${sourceId}.` };
        sourceWarnings.push(warning('INVALID_INSTRUMENT', lastError.message, sourceId));
        continue;
      }
      const cacheScope = request.credentialScope === 'public'
        ? candidate.instance.credentialScope
        : request.credentialScope;
      const decision = decideCache({
        capability: candidate.spec,
        credentialScope: cacheScope,
        allowStaleIfError: policy.allowStaleIfError,
        maxStaleMs: policy.maxStaleMs,
      });
      const key = decision.readScope === 'none' ? undefined : cacheKey({
        sourceId,
        capability: request.capability,
        scope: decision.readScope,
        input: request.input,
      });
      if (key) {
        const cached = await this.cache.get<SourceResult<T>>(key);
        if (cached && !cached.stale && isFreshEnough(cached.value, policy, this.now())) {
          recordAttempt({ sourceId, capability: request.capability, outcome: 'hit', cache: 'hit' });
          if (!collectsMultipleSources(policy.strategy)) {
            return this.complete(request, traceId, success(cached.value, attempts, policy, candidate.spec.authority, sourceWarnings));
          }
          successful.push({ result: cached.value, authority: candidate.spec.authority });
          continue;
        }
        if (cached?.stale && !stale) {
          stale = {
            result: cached.value,
            attempt: { sourceId, capability: request.capability, outcome: 'hit', cache: 'stale' },
            allowed: decision.staleTtlMs > 0,
          };
        }
      }

      if (!this.rateLimiter.tryAcquire(sourceId, candidate.instance.manifest.rateLimit, request.rateLimitCost)) {
        recordAttempt({ sourceId, capability: request.capability, outcome: 'skipped', cache: 'bypass', reasonCode: 'RATE_LIMITED' });
        lastError = { code: 'RATE_LIMITED', message: `${sourceId} rate limit is exhausted.` };
        sourceWarnings.push(warning('RATE_LIMITED', lastError.message, sourceId));
        continue;
      }

      const startedAt = this.now().getTime();
      const timeoutMs = request.timeoutMs ?? this.defaultTimeoutMs;
      const context: Omit<SourceRequestContext, 'signal'> = {
        timeoutMs,
        credentialScope: candidate.instance.credentialScope,
        traceId,
        now: this.now,
        ...(resolvedInstrument ? { resolvedInstrument } : {}),
      };
      try {
        const result = await runSourceOperation(
          operation,
          candidate.instance,
          context,
          request.signal,
          timeoutMs,
        );
        const latencyMs = this.now().getTime() - startedAt;
        const identityRejected = result.sourceId !== sourceId;
        const freshnessRejected = !identityRejected && result.status === 'ok' && !isFreshEnough(result, policy, this.now());
        const reasonCode = identityRejected || freshnessRejected ? 'VALIDATION_FAILED' : result.status === 'ok' ? undefined : result.error?.code;
        recordAttempt({
          sourceId,
          capability: request.capability,
          outcome: identityRejected || freshnessRejected ? 'failed' : result.status === 'ok' ? 'hit' : result.status,
          cache: 'miss',
          latencyMs,
          ...(reasonCode ? { reasonCode } : {}),
        });
        if (identityRejected) {
          lastError = { code: 'VALIDATION_FAILED', message: `${sourceId} returned a result for unexpected source ${result.sourceId}.` };
          sourceWarnings.push(warning('PARTIAL_DATA', lastError.message, sourceId));
          this.health.recordFailure(sourceId, lastError.code);
          continue;
        }
        if (freshnessRejected) {
          lastError = { code: 'VALIDATION_FAILED', message: `${sourceId} returned data older than the routing maxAgeMs.` };
          sourceWarnings.push(warning('STALE_DATA', lastError.message, sourceId));
          this.health.recordFailure(sourceId, lastError.code);
          continue;
        }
        if (result.status === 'ok') {
          this.health.recordSuccess(sourceId);
          if (key && decision.writeScope !== 'none') {
            await this.cache.set(key, result, decision.ttlMs, decision.staleTtlMs);
          }
          if (!collectsMultipleSources(policy.strategy)) {
            return this.complete(request, traceId, success(result, attempts, policy, candidate.spec.authority, sourceWarnings));
          }
          successful.push({ result, authority: candidate.spec.authority });
          continue;
        }
        sourceWarnings.push(...result.warnings);
        if (result.status === 'failed' && result.error) {
          lastError = result.error;
          if (result.warnings.length === 0) {
            sourceWarnings.push(warning('SOURCE_UNAVAILABLE', result.error.message, sourceId));
          }
          this.health.recordFailure(sourceId, result.error.code);
        }
      } catch (error) {
        const failure = routeFailure(error);
        recordAttempt({ sourceId, capability: request.capability, outcome: 'failed', cache: 'miss', latencyMs: this.now().getTime() - startedAt, reasonCode: failure.code });
        if (failure.code !== 'ABORTED') this.health.recordFailure(sourceId, failure.code);
        lastError = failure;
        if (failure.code !== 'ABORTED') {
          sourceWarnings.push(warning('SOURCE_UNAVAILABLE', failure.message, sourceId));
        }
        if (failure.code === 'ABORTED') {
          return this.complete(request, traceId, failed(attempts, failure, sourceWarnings));
        }
      } finally {
        this.rateLimiter.release(sourceId);
      }
    }

    if (successful.length > 0) {
      const data = policy.strategy === 'merge'
        ? options.merge?.(successful.map((item) => item.result)) ?? successful[0]!.result.data
        : successful[0]!.result.data;
      if (data !== null) {
        const sources = successful.map((item) => item.result.sourceId);
        const hadFailure = attempts.some((attempt) => attempt.outcome === 'failed' || attempt.outcome === 'empty');
        const conflicts = policy.strategy === 'cross-check'
          ? findConflicts(successful.map((item) => item.result.data), policy)
          : [];
        const minimumSources = policy.crossCheck?.minSources ?? 2;
        const coverageGaps = policy.strategy === 'cross-check'
          ? findCoverageGaps(successful.map((item) => item.result.data), policy)
          : [];
        const insufficientCrossCheck = policy.strategy === 'cross-check' &&
          (successful.length < minimumSources || coverageGaps.length > 0);
        const incompleteMultiSource = hadFailure && collectsMultipleSources(policy.strategy);
        const failedSources = attempts
          .filter((attempt) => attempt.outcome === 'failed' || attempt.outcome === 'empty')
          .map((attempt) => attempt.sourceId);
        const warnings = [
          ...sourceWarnings,
          ...successful.flatMap((item) => item.result.warnings),
          ...(incompleteMultiSource
            ? [warning(
                'PARTIAL_COVERAGE',
                `Some sources did not return usable ${request.capability} data: ${failedSources.join(', ')}.`,
                failedSources.join(','),
              )]
            : []),
          ...conflicts.map((field) => warning('DATA_CONFLICT', `Cross-check found conflicting values for ${field}.`, sources.join(','))),
          ...(insufficientCrossCheck
            ? [warning(
                'PARTIAL_COVERAGE',
                coverageGaps.length > 0
                  ? `Cross-check requires ${minimumSources} numeric values for: ${coverageGaps.join(', ')}.`
                  : `Cross-check requires ${minimumSources} sources; received ${successful.length}.`,
                sources.join(','),
              )]
            : []),
        ];
        return this.complete(request, traceId, {
          status: hadFailure || conflicts.length > 0 || insufficientCrossCheck ? 'partial' : 'ok',
          data,
          ...(policy.strategy === 'cross-check' ? { selectedSource: sources[0] } : {}),
          mergedSources: sources,
          citations: dedupe(successful.flatMap((item) => item.result.citations)),
          freshness: successful.flatMap((item) => item.result.freshness),
          warnings: dedupeWarnings(warnings),
          attempts,
        });
      }
    }

    if (stale?.allowed) {
      return this.complete(request, traceId, {
        status: 'partial',
        data: stale.result.data as T,
        selectedSource: stale.result.sourceId,
        citations: stale.result.citations,
        freshness: stale.result.freshness,
        warnings: dedupeWarnings([...sourceWarnings, ...stale.result.warnings, warning('STALE_DATA', 'Returning stale cached data after all live sources failed.', stale.result.sourceId)]),
        attempts: [...attempts, stale.attempt],
      });
    }
    return this.complete(request, traceId, failed(attempts, lastError ?? { code: 'EMPTY_RESPONSE', message: 'No source returned usable data.' }, sourceWarnings));
  }

  private complete<T>(request: RouteRequest, traceId: string, result: RoutedResult<T>): RoutedResult<T> {
    this.eventSink.emit({
      type: 'route.completed',
      traceId,
      capability: request.capability,
      market: request.market,
      status: result.status,
      attempts: result.attempts,
    });
    return result;
  }
}

class RouteInterruption extends Error {
  constructor(readonly code: 'TIMEOUT' | 'ABORTED', message: string) {
    super(message);
    this.name = 'RouteInterruption';
  }
}

async function runSourceOperation<T>(
  operation: SourceOperation<T>,
  source: SourceInstance,
  context: Omit<SourceRequestContext, 'signal'>,
  callerSignal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<SourceResult<T>> {
  const controller = new AbortController();
  let timedOut = false;
  let rejectInterruption: ((reason: RouteInterruption) => void) | undefined;
  const interruption = new Promise<never>((_resolve, reject) => {
    rejectInterruption = reject;
  });
  const onAbort = (): void => {
    const reason = timedOut
      ? new RouteInterruption('TIMEOUT', `${source.manifest.id} exceeded the ${timeoutMs}ms routing deadline.`)
      : new RouteInterruption('ABORTED', 'Market-data request was aborted by the caller.');
    rejectInterruption?.(reason);
  };
  const onCallerAbort = (): void => controller.abort(callerSignal?.reason);
  controller.signal.addEventListener('abort', onAbort, { once: true });
  if (callerSignal?.aborted) onCallerAbort();
  else callerSignal?.addEventListener('abort', onCallerAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error(`Routing deadline exceeded after ${timeoutMs}ms.`));
  }, Math.max(1, timeoutMs));

  try {
    return await Promise.race([
      Promise.resolve().then(() => operation(source, { ...context, signal: controller.signal })),
      interruption,
    ]);
  } finally {
    clearTimeout(timer);
    controller.signal.removeEventListener('abort', onAbort);
    callerSignal?.removeEventListener('abort', onCallerAbort);
  }
}

function routeFailure(error: unknown): SourceError {
  if (error instanceof RouteInterruption) return { code: error.code, message: error.message };
  return {
    code: 'SOURCE_UNAVAILABLE',
    message: error instanceof Error ? error.message : String(error),
  };
}

function skipFailure(reason: NonNullable<import('./planner').PlannedCandidate['skipReason']>, sourceId: string): SourceError {
  switch (reason) {
    case 'AUTH_UNAVAILABLE':
      return { code: 'AUTH_REQUIRED', message: `${sourceId} requires credentials that are not available.` };
    case 'CIRCUIT_OPEN':
      return { code: 'CIRCUIT_OPEN', message: `${sourceId} is in cooldown after repeated transient failures.` };
    case 'POLICY_DISABLED':
      return { code: 'PERMISSION_DENIED', message: `${sourceId} is disabled by the active routing policy.` };
    case 'DISABLED':
      return { code: 'SOURCE_UNAVAILABLE', message: `${sourceId} is disabled.` };
  }
}

function collectsMultipleSources(strategy: RoutingPolicy['strategy']): boolean {
  return strategy === 'merge' || strategy === 'cross-check';
}

function findConflicts<T>(values: readonly T[], policy: RoutingPolicy): string[] {
  const config = policy.crossCheck;
  if (!config || values.length < 2) return [];
  return config.fields.filter((field) => {
    const numbers = values
      .map((value) => numericField(value, field))
      .filter((value): value is number => value !== undefined);
    if (numbers.length < (config.minSources ?? 2)) return false;
    const baseline = numbers[0]!;
    return numbers.slice(1).some((candidate) => relativeDifference(baseline, candidate) > config.tolerance);
  });
}

function findCoverageGaps<T>(values: readonly T[], policy: RoutingPolicy): string[] {
  const config = policy.crossCheck;
  if (!config) return [];
  const minimumSources = config.minSources ?? 2;
  return config.fields.filter((field) =>
    values.filter((value) => numericField(value, field) !== undefined).length < minimumSources,
  );
}

function numericField(value: unknown, path: string): number | undefined {
  let current: unknown = value;
  for (const segment of path.split('.')) {
    if (typeof current !== 'object' || current === null) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return typeof current === 'number' && Number.isFinite(current) ? current : undefined;
}

function relativeDifference(left: number, right: number): number {
  const denominator = Math.max(Math.abs(left), Math.abs(right), Number.EPSILON);
  return Math.abs(left - right) / denominator;
}

function isFreshEnough<T>(result: SourceResult<T>, policy: RoutingPolicy, now: Date): boolean {
  if (result.status !== 'ok' || policy.maxAgeMs === undefined) return result.status === 'ok';
  if (result.freshness.length === 0) return false;
  return result.freshness.some((freshness) => {
    const asOf = Date.parse(freshness.asOf);
    return Number.isFinite(asOf) && now.getTime() - asOf <= policy.maxAgeMs!;
  });
}

function success<T>(
  result: SourceResult<T>,
  attempts: SourceAttempt[],
  policy: RoutingPolicy,
  authority: string,
  sourceWarnings: readonly ResearchWarning[] = [],
): RoutedResult<T> {
  if (result.status !== 'ok') return failed(attempts, result.error ?? { code: 'EMPTY_RESPONSE', message: 'Source returned no data.' });
  const usedFallback = attempts.some((attempt) => attempt.outcome === 'failed' || attempt.outcome === 'empty');
  const downgradedAuthority = policy.strategy === 'official-first' && authority !== 'regulator' && authority !== 'exchange' && authority !== 'official-derived';
  const fallbackAttempts = attempts.filter((attempt) =>
    attempt.sourceId !== result.sourceId && attempt.outcome !== 'hit' && attempt.reasonCode !== 'POLICY_DISABLED');
  const warnings = dedupeWarnings([
    ...sourceWarnings,
    ...result.warnings,
    ...(usedFallback || fallbackAttempts.length > 0 ? [warning(
      'FALLBACK_USED',
      `Used ${result.sourceId} after ${fallbackAttempts.map((attempt) => `${attempt.sourceId}(${attempt.reasonCode ?? attempt.outcome})`).join(', ')} was unavailable.`,
      result.sourceId,
    )] : []),
    ...(downgradedAuthority ? [warning('OFFICIAL_SOURCE_UNAVAILABLE', `No official ${policy.capability} source was usable.`, result.sourceId)] : []),
  ]);
  return {
    status: downgradedAuthority || result.warnings.some((item) => isPartialWarning(item.code)) ? 'partial' : 'ok',
    data: result.data,
    selectedSource: result.sourceId,
    citations: result.citations,
    freshness: result.freshness,
    warnings,
    attempts,
  };
}

function isPartialWarning(code: ResearchWarning['code']): boolean {
  return code === 'PARTIAL_DATA' ||
    code === 'PARTIAL_COVERAGE' ||
    code === 'DATA_CONFLICT' ||
    code === 'STALE_DATA';
}

function failed<T>(attempts: SourceAttempt[], error: SourceError, warnings: readonly ResearchWarning[] = []): RoutedResult<T> {
  return { status: error.code === 'EMPTY_RESPONSE' ? 'empty' : 'failed', data: null, citations: [], freshness: [], warnings: dedupeWarnings(warnings), attempts, error };
}

function warning(code: ResearchWarning['code'], message: string, provider: string): ResearchWarning {
  return { code, message, provider };
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

function dedupeWarnings(values: readonly ResearchWarning[]): ResearchWarning[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = `${value.provider ?? ''}:${value.code}:${value.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
