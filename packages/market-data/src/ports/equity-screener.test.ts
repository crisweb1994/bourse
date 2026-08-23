import { describe, expect, it } from 'vitest';
import { EquityScreenerSnapshotSchema } from './equity-screener';

describe('EquityScreenerSnapshotSchema', () => {
  it('requires providerAsOf to be an ISO datetime', () => {
    const snapshot = {
      universeCount: 0,
      matchedCount: 0,
      providerAsOf: '2026-08-22T00:00:00.000Z',
      complete: true,
      truncated: false,
      items: [],
    };

    expect(EquityScreenerSnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(EquityScreenerSnapshotSchema.safeParse({
      ...snapshot,
      providerAsOf: 'not-a-datetime',
    }).success).toBe(false);
  });
});
