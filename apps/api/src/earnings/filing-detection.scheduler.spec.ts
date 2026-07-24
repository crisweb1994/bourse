import test from 'node:test';
import assert from 'node:assert/strict';
import { FilingDetectionScheduler } from './filing-detection.scheduler';

function scheduler(input: { createDetected?: () => Promise<any>; failureCount?: number } = {}) {
  const updates: any[] = [];
  const prisma = {
    watchlistItem: { findMany: async () => [{ stockId: 'stock-1' }] },
    filingDetectionCursor: {
      upsert: async () => ({}),
      findMany: async () => [{ stockId: 'stock-1' }],
      findUnique: async () => ({ failureCount: input.failureCount ?? 0 }),
      update: async (args: any) => { updates.push(args.data); return args.data; },
    },
    stock: { findUnique: async () => ({ id: 'stock-1', symbol: 'AAPL', market: 'US' }) },
  };
  const queued: string[] = [];
  const generations = {
    createDetected: async (stockId: string) => {
      queued.push(stockId);
      return input.createDetected
        ? input.createDetected()
        : { createdAt: new Date('2026-07-20T00:00:00.000Z'), sourceDescriptor: { sourceDocumentId: 'filing-1' } };
    },
  };
  return {
    instance: new FilingDetectionScheduler(
      prisma as any,
      { get: (key: string) => key === 'EARNINGS_DETECTION_INTERVAL_MS' ? '300000' : undefined } as any,
      generations as any,
      { capture: async () => 0 } as any,
    ),
    queued,
    updates,
  };
}

test('filing detector scans a due watchlist stock without a database lease', async () => {
  const { instance, queued, updates } = scheduler();
  await instance.tick();
  assert.deepEqual(queued, ['stock-1']);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].lastSourceDocumentId, 'filing-1');
  assert.equal(updates[0].failureCount, 0);
  assert.equal('leaseUntil' in updates[0], false);
});

test('no eligible filing is a normal scan result, not a backoff failure', async () => {
  const error = Object.assign(new Error('none'), { code: 'NO_ELIGIBLE_FILING' });
  const { instance, updates } = scheduler({
    failureCount: 4,
    createDetected: async () => { throw error; },
  });
  await instance.tick();
  assert.equal(updates[0].failureCount, 0);
  assert.equal(updates[0].lastError, null);
});
