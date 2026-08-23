import { describe, expect, it, vi } from 'vitest';
import type { SourceResult } from '../contracts/source-result';
import type { CapabilitySpec, SourceManifest } from '../contracts/source';
import { MemoryCache } from '../cache/memory-cache';
import { cacheKey } from '../cache/keys';
import { InMemorySourceHealth } from '../sources/health';
import { InMemoryRateLimiter } from '../sources/rate-limit';
import type { SourceInstance, SourcePorts } from '../sources/plugin';
import { SourceRegistry } from '../sources/registry';
import { CapabilityPlanner } from './planner';
import { RoutingPolicies, type RoutingPolicy } from './policy';
import { CapabilityRouter } from './router';
import type { MarketDataEvent } from '../observability/events';

const quoteSpec: CapabilitySpec = {
  capability: 'quote',
  markets: ['HK'],
  qualityTier: 'B',
  authority: 'licensed',
  redistribution: 'public-cache-allowed',
  ttlMs: 60_000,
};

function source(id: string, spec: CapabilitySpec = quoteSpec, scope: SourceInstance['credentialScope'] = 'public'): SourceInstance {
  const manifest: SourceManifest = {
    id,
    name: id,
    sourceType: 'public-api',
    requiresAuth: scope !== 'public',
    allowRedistribution: spec.redistribution === 'public-cache-allowed',
    capabilities: [spec],
    rateLimit: { concurrent: 4 },
  };
  return { manifest, enabled: true, credentialScope: scope, ports: portsFor(spec.capability) };
}

function portsFor(capability: CapabilitySpec['capability']): SourcePorts {
  const notCalled = async (): Promise<never> => { throw new Error('test port should not be called'); };
  switch (capability) {
    case 'quote':
    case 'history':
    case 'profile':
    case 'earnings-consensus':
      return { finance: { getQuote: notCalled, getHistory: notCalled, getProfile: notCalled, fetchEarningsConsensus: notCalled } };
    case 'financials': return { financials: { fetchFinancials: notCalled } };
    case 'filings':
    case 'filing-document': return { filings: { searchFilings: notCalled, getFiling: notCalled } };
    case 'macro': return { macro: { fetchMacro: notCalled } };
    case 'instrument-search': return { instrumentSearch: { search: notCalled } };
    case 'market-calendar': return { marketCalendar: { getMarketSession: notCalled } };
    case 'corporate-actions': return { corporateActions: { listActions: notCalled } };
    case 'ownership': return { ownership: { listOwnership: notCalled } };
    case 'market-events': return { marketEvents: { listEvents: notCalled } };
    case 'equity-screener': return { equityScreener: { describe: notCalled, screen: notCalled } };
  }
}

function ok(sourceId: string): SourceResult<{ price: number }> {
  return { status: 'ok', data: { price: 100 }, sourceId, citations: [], freshness: [], warnings: [] };
}

function failed(sourceId: string): SourceResult<{ price: number }> {
  return {
    status: 'failed',
    data: null,
    sourceId,
    citations: [],
    freshness: [],
    warnings: [],
    error: { code: 'RATE_LIMITED', message: 'too many requests' },
  };
}

function router(sources: SourceInstance[], policy: RoutingPolicy): CapabilityRouter {
  const health = new InMemorySourceHealth();
  return new CapabilityRouter(
    new CapabilityPlanner(new SourceRegistry(sources), health),
    new RoutingPolicies([policy]),
    health,
    new InMemoryRateLimiter(),
    new MemoryCache(),
  );
}

describe('CapabilityRouter', () => {
  const policy: RoutingPolicy = {
    capability: 'quote',
    market: 'HK',
    strategy: 'fallback',
    preferredSources: ['primary', 'fallback'],
  };

  it('falls back without exposing provider order to the caller', async () => {
    const operation = vi.fn(async (instance: SourceInstance) =>
      instance.manifest.id === 'primary' ? failed('primary') : ok('fallback'));
    const result = await router([source('primary'), source('fallback')], policy).fetch(
      { capability: 'quote', market: 'HK', input: { instrumentId: 'HK:0700' }, credentialScope: 'public' },
      operation,
    );

    if (result.status === 'empty' || result.status === 'failed') throw new Error('expected routed quote');
    expect(result.status).toBe('ok');
    expect(result.data).toEqual({ price: 100 });
    expect(result.selectedSource).toBe('fallback');
    expect(result.warnings.some((warning) => warning.code === 'FALLBACK_USED')).toBe(true);
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('preserves a failed source warning when fallback succeeds', async () => {
    const result = await router([source('primary'), source('fallback')], policy).fetch(
      { capability: 'quote', market: 'HK', input: {}, credentialScope: 'public' },
      async (instance) => instance.manifest.id === 'primary'
        ? {
            status: 'failed',
            data: null,
            sourceId: 'primary',
            citations: [],
            freshness: [],
            warnings: [{ code: 'RATE_LIMITED', message: 'primary quota exhausted', provider: 'primary' }],
            error: { code: 'RATE_LIMITED', message: 'primary quota exhausted' },
          }
        : ok('fallback'),
    );

    expect(result.status).toBe('ok');
    expect(result.warnings).toContainEqual(expect.objectContaining({
      code: 'RATE_LIMITED',
      provider: 'primary',
    }));
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: 'FALLBACK_USED' }));
  });

  it('prefers an official capability over configured source order', async () => {
    const official = source('hkex', { ...quoteSpec, authority: 'exchange', qualityTier: 'A' });
    const vendor = source('vendor');
    const operation = vi.fn(async (instance: SourceInstance) => ok(instance.manifest.id));
    const result = await router([vendor, official], { ...policy, strategy: 'official-first', preferredSources: ['vendor', 'hkex'] }).fetch(
      { capability: 'quote', market: 'HK', input: { instrumentId: 'HK:0700' }, credentialScope: 'public' },
      operation,
    );

    if (result.status === 'empty' || result.status === 'failed') throw new Error('expected routed quote');
    expect(result.selectedSource).toBe('hkex');
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('does not reuse a credential source result through the public cache', async () => {
    const secured = source('licensed', { ...quoteSpec, redistribution: 'credential-cache-only' }, 'credential:licensed-system');
    const operation = vi.fn(async () => ok('licensed'));
    const marketData = router([secured], { ...policy, preferredSources: ['licensed'] });
    const request = { capability: 'quote' as const, market: 'HK' as const, input: { instrumentId: 'HK:0700' }, credentialScope: 'public' as const };

    await marketData.fetch(request, operation);
    await marketData.fetch(request, operation);

    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('returns stale cache as partial only after live sources fail', async () => {
    let now = 0;
    const cache = new MemoryCache(1_000, () => now);
    const health = new InMemorySourceHealth(10);
    const marketData = new CapabilityRouter(
      new CapabilityPlanner(new SourceRegistry([source('primary', { ...quoteSpec, ttlMs: 10, allowStaleIfError: true, maxStaleMs: 100 })]), health),
      new RoutingPolicies([{ ...policy, allowStaleIfError: true }]),
      health,
      new InMemoryRateLimiter(),
      cache,
      { now: () => new Date(now) },
    );
    const request = { capability: 'quote' as const, market: 'HK' as const, input: { instrumentId: 'HK:0700' }, credentialScope: 'public' as const };

    await marketData.fetch(request, async () => ok('primary'));
    now = 20;
    const result = await marketData.fetch(request, async () => failed('primary'));

    expect(result.status).toBe('partial');
    if (result.status !== 'partial') throw new Error('expected stale result');
    expect(result.warnings.some((warning) => warning.code === 'STALE_DATA')).toBe(true);
  });

  it('uses the routing policy maxStaleMs instead of the source default', async () => {
    let now = 0;
    const cache = new MemoryCache(1_000, () => now);
    const health = new InMemorySourceHealth(10);
    const marketData = new CapabilityRouter(
      new CapabilityPlanner(new SourceRegistry([source('primary', {
        ...quoteSpec,
        ttlMs: 10,
        allowStaleIfError: true,
        maxStaleMs: 1_000,
      })]), health),
      new RoutingPolicies([{ ...policy, allowStaleIfError: true, maxStaleMs: 5 }]),
      health,
      new InMemoryRateLimiter(),
      cache,
      { now: () => new Date(now) },
    );
    const request = { capability: 'quote' as const, market: 'HK' as const, input: {}, credentialScope: 'public' as const };

    await marketData.fetch(request, async () => ok('primary'));
    now = 20;
    const result = await marketData.fetch(request, async () => failed('primary'));

    expect(result.status).toBe('failed');
    expect(result.warnings.some((warning) => warning.code === 'STALE_DATA')).toBe(false);
  });

  it('keeps the highest-priority stale value when every live source fails', async () => {
    let now = 0;
    const cache = new MemoryCache(1_000, () => now);
    const staleSpec = { ...quoteSpec, ttlMs: 10, allowStaleIfError: true, maxStaleMs: 100 };
    const health = new InMemorySourceHealth(10);
    const marketData = new CapabilityRouter(
      new CapabilityPlanner(new SourceRegistry([source('primary', staleSpec), source('fallback', staleSpec)]), health),
      new RoutingPolicies([{ ...policy, allowStaleIfError: true }]),
      health,
      new InMemoryRateLimiter(),
      cache,
      { now: () => new Date(now) },
    );
    const input = { instrumentId: 'HK:0700' };
    await cache.set(cacheKey({ sourceId: 'primary', capability: 'quote', scope: 'public', input }), ok('primary'), 10, 100);
    await cache.set(cacheKey({ sourceId: 'fallback', capability: 'quote', scope: 'public', input }), {
      ...ok('fallback'),
      data: { price: 90 },
    }, 10, 100);
    now = 20;

    const result = await marketData.fetch(
      { capability: 'quote', market: 'HK', input, credentialScope: 'public' },
      async (instance) => failed(instance.manifest.id),
    );

    expect(result.status).toBe('partial');
    if (result.status !== 'partial') throw new Error('expected stale result');
    expect(result.selectedSource).toBe('primary');
    expect(result.data.price).toBe(100);
  });

  it('passes a source-specific resolved symbol to connector context', async () => {
    const seen: string[] = [];
    const result = await router([source('tencent-hk')], { ...policy, preferredSources: ['tencent-hk'] }).fetch(
      {
        capability: 'quote',
        market: 'HK',
        instrumentId: 'HK:0700',
        input: { instrumentId: 'HK:0700' },
        credentialScope: 'public',
      },
      async (_source, context) => {
        seen.push(context.resolvedInstrument?.providerSymbol ?? 'missing');
        return ok('tencent-hk');
      },
    );

    expect(result.status).toBe('ok');
    expect(seen).toEqual(['hk00700']);
  });

  it('cross-checks configured numeric fields and keeps the preferred result', async () => {
    const operation = vi.fn(async (instance: SourceInstance): Promise<SourceResult<{ price: number }>> => ({
      status: 'ok',
      data: { price: instance.manifest.id === 'primary' ? 100 : 112 },
      sourceId: instance.manifest.id,
      citations: [],
      freshness: [],
      warnings: [],
    }));
    const result = await router([source('primary'), source('secondary')], {
      ...policy,
      strategy: 'cross-check',
      preferredSources: ['primary', 'secondary'],
      crossCheck: { fields: ['price'], tolerance: 0.05, minSources: 2 },
    }).fetch(
      { capability: 'quote', market: 'HK', input: {}, credentialScope: 'public' },
      operation,
    );

    expect(operation).toHaveBeenCalledTimes(2);
    expect(result.status).toBe('partial');
    if (result.status !== 'partial') throw new Error('expected cross-check result');
    expect(result.data.price).toBe(100);
    expect(result.selectedSource).toBe('primary');
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: 'DATA_CONFLICT' }));
  });

  it('reports partial coverage when a cross-check field lacks enough values', async () => {
    const result = await router([source('primary'), source('secondary')], {
      ...policy,
      strategy: 'cross-check',
      preferredSources: ['primary', 'secondary'],
      crossCheck: { fields: ['price'], tolerance: 0.05, minSources: 2 },
    }).fetch(
      { capability: 'quote', market: 'HK', input: {}, credentialScope: 'public' },
      async (instance): Promise<SourceResult<{ price?: number; volume: number }>> => ({
        status: 'ok',
        data: {
          ...(instance.manifest.id === 'primary' ? { price: 100 } : {}),
          volume: 1_000,
        },
        sourceId: instance.manifest.id,
        citations: [],
        freshness: [],
        warnings: [],
      }),
    );

    expect(result.status).toBe('partial');
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: 'PARTIAL_COVERAGE' }));
  });

  it('explains partial coverage when a merge source fails', async () => {
    const result = await router([source('primary'), source('fallback')], {
      ...policy,
      strategy: 'merge',
    }).fetch(
      { capability: 'quote', market: 'HK', input: {}, credentialScope: 'public' },
      async (instance) => instance.manifest.id === 'primary' ? ok('primary') : failed('fallback'),
      { merge: (results) => results[0]?.status === 'ok' ? results[0].data : null },
    );

    expect(result.status).toBe('partial');
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: 'PARTIAL_COVERAGE' }));
  });

  it('emits provider-neutral routing events', async () => {
    const events: MarketDataEvent[] = [];
    const health = new InMemorySourceHealth();
    const marketData = new CapabilityRouter(
      new CapabilityPlanner(new SourceRegistry([source('primary')]), health),
      new RoutingPolicies([policy]),
      health,
      new InMemoryRateLimiter(),
      new MemoryCache(),
      { eventSink: { emit: (event) => events.push(event) } },
    );

    await marketData.fetch(
      { capability: 'quote', market: 'HK', input: {}, credentialScope: 'public', traceId: 'trace-1' },
      async () => ok('primary'),
    );

    expect(events.map((event) => event.type)).toEqual([
      'route.planned',
      'source.attempted',
      'route.completed',
    ]);
    expect(events.every((event) => event.traceId === 'trace-1')).toBe(true);
  });

  it('does not consume a concurrent source slot for a cache hit', async () => {
    const limited = source('primary', quoteSpec);
    limited.manifest.rateLimit = { concurrent: 1 };
    const operation = vi.fn(async () => ok('primary'));
    const marketData = router([limited], policy);
    const request = { capability: 'quote' as const, market: 'HK' as const, input: {}, credentialScope: 'public' as const };

    await marketData.fetch(request, operation);
    await marketData.fetch(request, operation);

    expect(operation).toHaveBeenCalledOnce();
  });

  it('rejects data older than maxAgeMs and continues to the fallback source', async () => {
    const now = new Date('2026-07-29T12:00:00.000Z');
    const health = new InMemorySourceHealth();
    const marketData = new CapabilityRouter(
      new CapabilityPlanner(new SourceRegistry([source('primary'), source('fallback')]), health),
      new RoutingPolicies([{ ...policy, maxAgeMs: 60_000 }]),
      health,
      new InMemoryRateLimiter(),
      new MemoryCache(),
      { now: () => now },
    );
    const result = await marketData.fetch(
      { capability: 'quote', market: 'HK', input: {}, credentialScope: 'public' },
      async (instance): Promise<SourceResult<{ price: number }>> => ({
        status: 'ok',
        data: { price: instance.manifest.id === 'primary' ? 99 : 100 },
        sourceId: instance.manifest.id,
        citations: [],
        freshness: [{
          provider: instance.manifest.id,
          asOf: instance.manifest.id === 'primary' ? '2026-07-29T11:00:00.000Z' : '2026-07-29T11:59:30.000Z',
          retrievedAt: now.toISOString(),
          stale: false,
        }],
        warnings: [],
      }),
    );

    expect(result.data).toEqual({ price: 100 });
    expect(result.attempts[0]).toEqual(expect.objectContaining({ sourceId: 'primary', reasonCode: 'VALIDATION_FAILED' }));
  });

  it('rejects a source result whose sourceId does not match the attempted plugin', async () => {
    const result = await router([source('primary'), source('fallback')], policy).fetch(
      { capability: 'quote', market: 'HK', input: {}, credentialScope: 'public' },
      async (instance) => instance.manifest.id === 'primary' ? ok('spoofed') : ok('fallback'),
    );

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('expected fallback result');
    expect(result.selectedSource).toBe('fallback');
    expect(result.attempts[0]).toEqual(expect.objectContaining({ reasonCode: 'VALIDATION_FAILED' }));
  });

  it('enforces the routing deadline and falls back after a source timeout', async () => {
    let primaryAborted = false;
    const result = await router([source('primary'), source('fallback')], policy).fetch(
      {
        capability: 'quote',
        market: 'HK',
        input: {},
        credentialScope: 'public',
        timeoutMs: 10,
      },
      async (instance, context) => {
        if (instance.manifest.id === 'fallback') return ok('fallback');
        return new Promise<SourceResult<{ price: number }>>((_resolve, reject) => {
          context.signal?.addEventListener('abort', () => {
            primaryAborted = true;
            reject(context.signal?.reason);
          }, { once: true });
        });
      },
    );

    expect(result.status).toBe('ok');
    expect(primaryAborted).toBe(true);
    expect(result.attempts[0]).toEqual(expect.objectContaining({
      sourceId: 'primary',
      reasonCode: 'TIMEOUT',
    }));
  });

  it('caps each candidate with the policy attempt budget', async () => {
    const seenTimeouts: number[] = [];
    const result = await router(
      [source('primary'), source('fallback')],
      { ...policy, attemptTimeoutMs: 10 },
    ).fetch(
      {
        capability: 'quote',
        market: 'HK',
        input: {},
        credentialScope: 'public',
        timeoutMs: 100,
      },
      async (instance, context) => {
        seenTimeouts.push(context.timeoutMs ?? 0);
        if (instance.manifest.id === 'fallback') return ok('fallback');
        return new Promise<SourceResult<{ price: number }>>(() => undefined);
      },
    );

    expect(result.status).toBe('ok');
    expect(seenTimeouts).toEqual([10, 10]);
    expect(result.attempts[0]).toEqual(expect.objectContaining({
      sourceId: 'primary',
      reasonCode: 'TIMEOUT',
    }));
    expect(result.attempts[1]).toEqual(expect.objectContaining({
      sourceId: 'fallback',
      outcome: 'hit',
    }));
  });

  it('stops routing immediately when the caller aborts', async () => {
    const controller = new AbortController();
    controller.abort('cancelled');
    const operation = vi.fn(async () => ok('primary'));
    const result = await router([source('primary'), source('fallback')], policy).fetch(
      {
        capability: 'quote',
        market: 'HK',
        input: {},
        credentialScope: 'public',
        signal: controller.signal,
      },
      operation,
    );

    expect(result.status).toBe('failed');
    if (result.status !== 'failed') throw new Error('expected aborted route');
    expect(result.error?.code).toBe('ABORTED');
    expect(operation).not.toHaveBeenCalled();
  });

  it('does not call a source whose redistribution policy the request rejects', async () => {
    const noStore = source('no-store', {
      ...quoteSpec,
      redistribution: 'no-store',
    });
    const operation = vi.fn(async () => ok('no-store'));
    const result = await router(
      [noStore],
      { ...policy, preferredSources: ['no-store'] },
    ).fetch(
      {
        capability: 'quote',
        market: 'HK',
        input: {},
        credentialScope: 'public',
        constraints: { acceptedRedistribution: ['public-cache-allowed'] },
      },
      operation,
    );

    expect(result.status).toBe('failed');
    if (result.status !== 'failed') throw new Error('expected rejected route');
    expect(result.error?.code).toBe('PERMISSION_DENIED');
    expect(result.attempts).toContainEqual(expect.objectContaining({
      sourceId: 'no-store',
      reasonCode: 'POLICY_DISABLED',
    }));
    expect(operation).not.toHaveBeenCalled();
  });

  it('returns AUTH_REQUIRED when every candidate lacks credentials', async () => {
    const secured = source('licensed', quoteSpec, 'public');
    secured.manifest.requiresAuth = true;
    const operation = vi.fn(async () => ok('licensed'));
    const result = await router([secured], { ...policy, preferredSources: ['licensed'] }).fetch(
      { capability: 'quote', market: 'HK', input: {}, credentialScope: 'public' },
      operation,
    );

    expect(result.status).toBe('failed');
    if (result.status !== 'failed') throw new Error('expected auth failure');
    expect(result.error?.code).toBe('AUTH_REQUIRED');
    expect(result.attempts[0]).toEqual(expect.objectContaining({ reasonCode: 'AUTH_UNAVAILABLE' }));
    expect(operation).not.toHaveBeenCalled();
  });

  it('diagnoses an unsupported interval instead of returning an empty response', async () => {
    const daily = source('daily', { ...quoteSpec, capability: 'history', intervals: ['1d'] });
    const historyPolicy: RoutingPolicy = {
      capability: 'history',
      market: 'HK',
      strategy: 'fallback',
      preferredSources: ['daily'],
    };
    const result = await router([daily], historyPolicy).fetch(
      {
        capability: 'history',
        market: 'HK',
        input: {},
        interval: '1m',
        credentialScope: 'public',
      },
      async () => ok('daily'),
    );

    expect(result.status).toBe('failed');
    if (result.status !== 'failed') throw new Error('expected unsupported interval');
    expect(result.error?.code).toBe('UNSUPPORTED_INTERVAL');
  });

  it('diagnoses an unsupported security type', async () => {
    const stockOnly = source('stock-only', { ...quoteSpec, securityTypes: ['stock'] });
    const result = await router([stockOnly], { ...policy, preferredSources: ['stock-only'] }).fetch(
      { capability: 'quote', market: 'HK', input: {}, securityType: 'option', credentialScope: 'public' },
      async () => ok('stock-only'),
    );

    expect(result.status).toBe('failed');
    if (result.status !== 'failed') throw new Error('expected unsupported security type');
    expect(result.error?.code).toBe('UNSUPPORTED_SECURITY_TYPE');
  });

  it('distinguishes a missing capability-market policy from an unsupported market', async () => {
    const health = new InMemorySourceHealth();
    const marketData = new CapabilityRouter(
      new CapabilityPlanner(new SourceRegistry([source('primary')]), health),
      new RoutingPolicies([
        { ...policy, market: 'US' },
        { ...policy, capability: 'history', preferredSources: ['primary'] },
      ]),
      health,
      new InMemoryRateLimiter(),
      new MemoryCache(),
    );
    const result = await marketData.fetch(
      { capability: 'quote', market: 'HK', input: {}, credentialScope: 'public' },
      async () => ok('primary'),
    );

    expect(result.status).toBe('failed');
    if (result.status !== 'failed') throw new Error('expected unsupported request');
    expect(result.error?.code).toBe('UNSUPPORTED_REQUEST');
  });
});
