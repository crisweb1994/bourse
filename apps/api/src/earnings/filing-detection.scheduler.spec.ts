import test from 'node:test';
import assert from 'node:assert/strict';
import { FilingDetectionScheduler, parsePositiveInteger } from './filing-detection.scheduler';

test('filing detector claims a persisted lease and queues the watchlist stock once', async () => {
  const updates: any[] = [];
  let returnedCandidate = false;
  const tx = {
    $executeRaw: async () => 1,
    watchlistItem: {
      findMany: async () => [{ stockId: 'stock-1' }],
    },
    filingDetectionCursor: {
      upsert: async () => ({}),
      findMany: async () => {
        if (returnedCandidate) return [];
        returnedCandidate = true;
        return [{ stockId: 'stock-1' }];
      },
      updateMany: async () => ({ count: 1 }),
    },
  };
  const prisma = {
    $transaction: async (fn: any) => fn(tx),
    filingDetectionCursor: {
      update: async (args: any) => {
        updates.push(args);
        return args.data;
      },
    },
    stock: { findUnique: async () => ({ id: 'stock-1', symbol: 'AAPL', market: 'US' }) },
  };
  const queued: string[] = [];
  const generations = {
    createDetected: async (stockId: string) => {
      queued.push(stockId);
      return {
        createdAt: new Date('2026-07-20T00:00:00.000Z'),
        sourceDescriptor: { sourceDocumentId: 'filing-1' },
      };
    },
  };
  const scheduler = new FilingDetectionScheduler(
    prisma as any,
    { get: (key: string) => key === 'EARNINGS_DETECTION_INTERVAL_MS' ? '300000' : undefined } as any,
    generations as any,
    { capture: async () => 0 } as any,
  );

  await scheduler.tick();

  assert.deepEqual(queued, ['stock-1']);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].data.leaseUntil, null);
  assert.equal(updates[0].data.lastSourceDocumentId, 'filing-1');
  assert.equal(updates[0].data.failureCount, 0);
});

test('no eligible filing is a normal scan result, not a backoff failure', async () => {
  let finalUpdate: any;
  let returnedCandidate = false;
  const tx = {
    $executeRaw: async () => 1,
    watchlistItem: { findMany: async () => [{ stockId: 'stock-1' }] },
    filingDetectionCursor: {
      upsert: async () => ({}),
      findMany: async () => {
        if (returnedCandidate) return [];
        returnedCandidate = true;
        return [{ stockId: 'stock-1' }];
      },
      updateMany: async () => ({ count: 1 }),
    },
  };
  const prisma = {
    $transaction: async (fn: any) => fn(tx),
    filingDetectionCursor: {
      findUnique: async () => ({ failureCount: 4 }),
      update: async (args: any) => {
        finalUpdate = args.data;
        return args.data;
      },
    },
    stock: { findUnique: async () => ({ id: 'stock-1', symbol: 'AAPL', market: 'US' }) },
  };
  const error = Object.assign(new Error('none'), { code: 'NO_ELIGIBLE_FILING' });
  const scheduler = new FilingDetectionScheduler(
    prisma as any,
    { get: (key: string) => key === 'EARNINGS_DETECTION_INTERVAL_MS' ? '300000' : undefined } as any,
    { createDetected: async () => { throw error; } } as any,
    { capture: async () => 0 } as any,
  );

  await scheduler.tick();

  assert.equal(finalUpdate.failureCount, 0);
  assert.equal(finalUpdate.lastError, null);
  assert.equal(finalUpdate.leaseUntil, null);
});

test('filing detector claims only the configured immediately-runnable concurrency', async () => {
  let take = 0;
  const tx = {
    $executeRaw: async () => 1,
    watchlistItem: { findMany: async () => [{ stockId: 'stock-1' }] },
    filingDetectionCursor: {
      upsert: async () => ({}),
      findMany: async (args: any) => {
        take = args.take;
        return [];
      },
      updateMany: async () => ({ count: 0 }),
    },
  };
  const scheduler = new FilingDetectionScheduler(
    { $transaction: async (fn: any) => fn(tx) } as any,
    { get: (key: string) => key === 'EARNINGS_DETECTION_BATCH_SIZE' ? '75' : key === 'EARNINGS_DETECTION_CONCURRENCY' ? '7' : undefined } as any,
    {} as any,
    {} as any,
  );
  await scheduler.tick();
  assert.equal(take, 7);
  assert.equal(parsePositiveInteger(undefined, 5, 1, 10, 'TEST'), 5);
  assert.throws(() => parsePositiveInteger('11', 5, 1, 10, 'TEST'), /TEST must be an integer/);
  assert.throws(
    () => parsePositiveInteger('900000', 300000, 60000, 600000, 'EARNINGS_DETECTION_INTERVAL_MS'),
    /EARNINGS_DETECTION_INTERVAL_MS must be an integer/,
  );
});
