import { describe, expect, it } from 'vitest';
import { InMemoryRateLimiter } from './rate-limit';

describe('InMemoryRateLimiter', () => {
  it('releases a concurrent slot after a connector call completes', () => {
    const limiter = new InMemoryRateLimiter();

    expect(limiter.tryAcquire('vendor', { concurrent: 1 })).toBe(true);
    expect(limiter.tryAcquire('vendor', { concurrent: 1 })).toBe(false);

    limiter.release('vendor');
    expect(limiter.tryAcquire('vendor', { concurrent: 1 })).toBe(true);
  });

  it('enforces request rate independently from concurrency', () => {
    const limiter = new InMemoryRateLimiter();

    expect(limiter.tryAcquire('vendor', { requestsPerSecond: 1, concurrent: 2 })).toBe(true);
    limiter.release('vendor');
    expect(limiter.tryAcquire('vendor', { requestsPerSecond: 1, concurrent: 2 })).toBe(false);
  });

  it('charges weighted batch requests against the rate window', () => {
    const limiter = new InMemoryRateLimiter();

    expect(limiter.tryAcquire('vendor', { requestsPerSecond: 5 }, 4)).toBe(true);
    limiter.release('vendor');
    expect(limiter.tryAcquire('vendor', { requestsPerSecond: 5 }, 2)).toBe(false);
    expect(limiter.tryAcquire('vendor', { requestsPerSecond: 5 }, 1)).toBe(true);
  });
});
