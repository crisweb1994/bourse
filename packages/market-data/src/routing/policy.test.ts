import { describe, expect, it } from 'vitest';
import { RoutingPolicies, type RoutingPolicy } from './policy';

describe('RoutingPolicies', () => {
  it('prefers an exact data-set policy and falls back to a capability policy', () => {
    const policies: RoutingPolicy[] = [
      { capability: 'ownership', market: 'CN', strategy: 'fallback', preferredSources: ['generic'] },
      { capability: 'ownership', dataSet: 'stock-connect', market: 'CN', strategy: 'fallback', preferredSources: ['connect'] },
    ];
    const registry = new RoutingPolicies(policies);

    expect(registry.find('ownership', 'CN', 'stock-connect')?.preferredSources).toEqual(['connect']);
    expect(registry.find('ownership', 'CN', 'shareholder-count')?.preferredSources).toEqual(['generic']);
    expect(registry.find('ownership', 'CN')?.preferredSources).toEqual(['generic']);
  });
});
