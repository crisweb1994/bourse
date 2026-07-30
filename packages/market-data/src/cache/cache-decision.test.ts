import { describe, expect, it } from 'vitest';
import type { CapabilitySpec } from '../contracts/source';
import { decideCache } from './cache-decision';

const quote: CapabilitySpec = {
  capability: 'quote',
  markets: ['US'],
  qualityTier: 'B',
  authority: 'licensed',
  ttlMs: 10_000,
  redistribution: 'public-cache-allowed',
};

describe('decideCache', () => {
  it('uses a public scope only for redistributable public data', () => {
    expect(decideCache({ capability: quote, credentialScope: 'public' }))
      .toEqual(expect.objectContaining({ readScope: 'public', writeScope: 'public' }));
  });

  it('keeps credential data inside its credential scope', () => {
    const decision = decideCache({
      capability: { ...quote, redistribution: 'credential-cache-only' },
      credentialScope: 'credential:user-1',
    });

    expect(decision.readScope).toBe('credential:user-1');
    expect(decision.writeScope).toBe('credential:user-1');
  });

  it('disables both reads and writes for no-store capabilities', () => {
    expect(decideCache({
      capability: { ...quote, redistribution: 'no-store' },
      credentialScope: 'public',
    })).toEqual(expect.objectContaining({ readScope: 'none', writeScope: 'none' }));
  });

  it('lets routing policy override the source stale window', () => {
    const decision = decideCache({
      capability: { ...quote, allowStaleIfError: true, maxStaleMs: 60_000 },
      credentialScope: 'public',
      allowStaleIfError: true,
      maxStaleMs: 5_000,
    });

    expect(decision.staleTtlMs).toBe(5_000);
  });
});
