import { describe, expect, it, vi } from 'vitest';
import type { SourceResult } from '../contracts/source-result';
import type { CapabilitySpec, SourceManifest } from '../contracts/source';
import { MemoryCache } from '../cache/memory-cache';
import { InMemorySourceHealth } from '../sources/health';
import { InMemoryRateLimiter } from '../sources/rate-limit';
import type { SourceInstance } from '../sources/plugin';
import { SourceRegistry } from '../sources/registry';
import { CapabilityPlanner } from './planner';
import { RoutingPolicies, type RoutingPolicy } from './policy';
import { CapabilityRouter } from './router';

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
  };
  return { manifest, enabled: true, credentialScope: scope, ports: {} };
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
});
