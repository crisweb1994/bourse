import { describe, expect, it } from 'vitest';
import type { CapabilitySpec, SourceManifest } from '../contracts/source';
import { InMemorySourceHealth } from '../sources/health';
import type { SourceInstance } from '../sources/plugin';
import { SourceRegistry } from '../sources/registry';
import { CapabilityPlanner, type RouteRequest } from './planner';
import type { RoutingPolicy } from './policy';

function source(id: string, spec: CapabilitySpec): SourceInstance {
  const manifest: SourceManifest = {
    id,
    name: id,
    sourceType: 'public-api',
    requiresAuth: false,
    allowRedistribution: true,
    capabilities: [spec],
    rateLimit: { concurrent: 2 },
  };
  const notCalled = async (): Promise<never> => { throw new Error('test port should not be called'); };
  return {
    manifest,
    enabled: true,
    credentialScope: 'public',
    ports: { finance: { getQuote: notCalled, getHistory: notCalled } },
  };
}

const request: RouteRequest = {
  capability: 'quote',
  market: 'US',
  input: {},
  credentialScope: 'public',
  securityType: 'stock',
  constraints: { minQualityTier: 'B', acceptedDelays: ['realtime'] },
};

const policy: RoutingPolicy = {
  capability: 'quote',
  market: 'US',
  strategy: 'fallback',
  preferredSources: ['realtime', 'unknown-delay', 'low-quality'],
  minQualityTier: 'C',
  acceptedDelays: ['realtime', 'delayed'],
};

describe('CapabilityPlanner', () => {
  it('applies request constraints when they are stricter than policy defaults', () => {
    const base: CapabilitySpec = {
      capability: 'quote',
      markets: ['US'],
      qualityTier: 'B',
      authority: 'licensed',
      ttlMs: 10_000,
      redistribution: 'public-cache-allowed',
      securityTypes: ['stock'],
    };
    const planner = new CapabilityPlanner(new SourceRegistry([
      source('realtime', { ...base, delay: 'realtime' }),
      source('unknown-delay', base),
      source('low-quality', { ...base, qualityTier: 'C', delay: 'realtime' }),
    ]), new InMemorySourceHealth());

    const planned = planner.plan(request, policy);

    expect(planned.map((candidate) => [candidate.instance.manifest.id, candidate.skipReason]))
      .toEqual([
        ['realtime', undefined],
        ['unknown-delay', 'POLICY_DISABLED'],
        ['low-quality', 'POLICY_DISABLED'],
      ]);
  });
});
