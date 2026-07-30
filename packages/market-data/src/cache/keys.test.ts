import { describe, expect, it } from 'vitest';
import { cacheKey, stableJson } from './keys';

describe('cache keys', () => {
  it('serializes object keys deterministically at every nesting level', () => {
    expect(stableJson({ b: 2, a: { d: 4, c: 3 } }))
      .toBe(stableJson({ a: { c: 3, d: 4 }, b: 2 }));
  });

  it('separates public and credential cache namespaces', () => {
    const input = { instrumentId: 'US:AAPL' };
    const publicKey = cacheKey({ sourceId: 'vendor', capability: 'quote', scope: 'public', input });
    const credentialKey = cacheKey({
      sourceId: 'vendor',
      capability: 'quote',
      scope: 'credential:user-1',
      input,
    });

    expect(publicKey).not.toBe(credentialKey);
  });
});
