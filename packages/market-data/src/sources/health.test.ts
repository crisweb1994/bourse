import { describe, expect, it } from 'vitest';
import { InMemorySourceHealth, isTransientSourceFailure } from './health';

describe('InMemorySourceHealth', () => {
  it('opens cooldown only for repeated transient failures', () => {
    let now = new Date('2026-07-29T00:00:00.000Z');
    const health = new InMemorySourceHealth(3, 30_000, () => now);

    health.recordFailure('vendor', 'AUTH_INVALID');
    health.recordFailure('vendor', 'UNSUPPORTED_INTERVAL');
    expect(health.get('vendor')).toEqual(expect.objectContaining({
      status: 'healthy',
      recentFailure: 0,
    }));

    health.recordFailure('vendor', 'TIMEOUT');
    health.recordFailure('vendor', 'NETWORK_ERROR');
    health.recordFailure('vendor', 'RATE_LIMITED');
    expect(health.get('vendor').status).toBe('cooldown');

    now = new Date('2026-07-29T00:00:31.000Z');
    expect(health.get('vendor')).toEqual(expect.objectContaining({
      status: 'degraded',
      recentFailure: 0,
    }));
  });

  it('keeps the transient taxonomy explicit', () => {
    expect(isTransientSourceFailure('VALIDATION_FAILED')).toBe(true);
    expect(isTransientSourceFailure('ABORTED')).toBe(false);
    expect(isTransientSourceFailure('CONFIG_MISSING')).toBe(false);
  });
});
