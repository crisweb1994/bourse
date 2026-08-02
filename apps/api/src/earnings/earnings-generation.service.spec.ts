import assert from 'node:assert/strict';
import test from 'node:test';
import { ConflictException } from '@nestjs/common';
import {
  buildEarningsGenerationIdempotencyKey,
  detectedRetryAt,
  EarningsGenerationService,
} from './earnings-generation.service';
import type { PreparedEarningsSource } from './earnings-source.service';
import { EarningsSourceError } from './earnings-source.service';

const filingSource: PreparedEarningsSource = {
  kind: 'filing',
  filingId: 'filing-1',
  derivationId: 'derivation-v1',
  provider: 'sec-edgar',
  sourceDocumentId: 'accession:release.htm',
  formType: '8-K',
  sourceUrl: 'https://example.com/release.htm',
  publishedAt: '2026-01-01T00:00:00.000Z',
  documentKind: 'EARNINGS_RELEASE',
  contentHash: 'a'.repeat(64),
  normalizedText: 'Revenue was 100.',
  derivationContentHash: 'b'.repeat(64),
};

test('earnings generation idempotency is stable for the same derivation', () => {
  assert.equal(
    buildEarningsGenerationIdempotencyKey('stock-1', filingSource),
    buildEarningsGenerationIdempotencyKey('stock-1', { ...filingSource }),
  );
});

test('earnings generation idempotency advances when the derivation changes', () => {
  assert.notEqual(
    buildEarningsGenerationIdempotencyKey('stock-1', filingSource),
    buildEarningsGenerationIdempotencyKey('stock-1', {
      ...filingSource,
      derivationId: 'derivation-v2',
    }),
  );
});

test('detected failures use exponential backoff', () => {
  const completedAt = new Date('2026-07-21T23:58:00.000Z');
  assert.equal(
    detectedRetryAt('FAILED', 1, completedAt).toISOString(),
    '2026-07-22T00:03:00.000Z',
  );
  assert.equal(
    detectedRetryAt('FAILED', 2, completedAt).toISOString(),
    '2026-07-22T00:08:00.000Z',
  );
});

test('detector atomically requeues a due retryable generation before rediscovery', async () => {
  const scheduled: string[] = [];
  let sourceCalls = 0;
  const failed = {
    id: 'run-1',
    stockId: 'stock-1',
    status: 'FAILED',
    retryable: true,
    attempt: 1,
    completedAt: new Date(Date.now() - 6 * 60_000),
  };
  const prisma = {
    stock: { findUnique: async () => ({ id: 'stock-1', market: 'US' }) },
    watchlistItem: { count: async () => 1 },
    earningsGenerationRun: {
      findFirst: async () => failed,
      updateMany: async () => ({ count: 1 }),
      findUnique: async () => ({ ...failed, status: 'QUEUED', attempt: 2, completedAt: null }),
    },
  };
  const service = new EarningsGenerationService(
    prisma as any,
    { discoverAndIngest: async () => { sourceCalls += 1; throw new Error('should not run'); } } as any,
    { schedule: (id: string) => scheduled.push(id) } as any,
  );

  const run = await service.createDetected('stock-1');

  assert.equal(run?.status, 'QUEUED');
  assert.deepEqual(scheduled, ['run-1']);
  assert.equal(sourceCalls, 0);
});

test('consistency-check retry excludes the failed filing group and queues a new run', async () => {
  const scheduled: string[] = [];
  const sourceOptions: unknown[] = [];
  let oldRunUpdated = false;
  const stock = { id: 'stock-1', symbol: '0700', market: 'HK' };
  const failed = {
    id: 'run-failed',
    stockId: stock.id,
    stock,
    status: 'FAILED',
    retryable: true,
    errorCode: 'CHECK_REJECTED_ALL',
    sourceDescriptor: {
      sourceGroupId: '0700:2026-04-09:annual',
      sourceDocumentId: 'annual-en',
    },
  };
  const alternate = {
    ...filingSource,
    filingId: 'filing-preliminary',
    derivationId: 'derivation-preliminary',
    provider: 'hkex',
    sourceDocumentId: 'preliminary-en',
    sourceGroupId: '0700:2026-03-18:preliminary',
    formType: 'preliminary',
  };
  const prisma = {
    watchlistItem: { count: async () => 1 },
    earningsGenerationRun: {
      findUnique: async ({ where }: any) => where.id === failed.id ? failed : null,
      create: async ({ data }: any) => ({ id: 'run-new', status: 'QUEUED', ...data }),
      update: async () => { oldRunUpdated = true; throw new Error('old run should not update'); },
    },
  };
  const service = new EarningsGenerationService(
    prisma as any,
    {
      discoverAndIngest: async (_stock: unknown, options: unknown) => {
        sourceOptions.push(options);
        return alternate;
      },
    } as any,
    { schedule: (id: string) => scheduled.push(id) } as any,
  );

  const result = await service.retry('user-1', failed.id);

  assert.equal(result.id, 'run-new');
  assert.deepEqual(sourceOptions, [{ excludedSourceGroupIds: ['0700:2026-04-09:annual'] }]);
  assert.deepEqual(scheduled, ['run-new']);
  assert.equal(oldRunUpdated, false);
});

test('ordinary retryable failure requeues the existing run', async () => {
  const scheduled: string[] = [];
  let sourceCalls = 0;
  const failed = {
    id: 'run-failed',
    stockId: 'stock-1',
    stock: { id: 'stock-1', market: 'US' },
    status: 'FAILED',
    retryable: true,
    errorCode: 'PROVIDER_TIMEOUT',
    sourceDescriptor: { sourceGroupId: 'accession-1' },
  };
  const prisma = {
    watchlistItem: { count: async () => 1 },
    earningsGenerationRun: {
      findUnique: async () => failed,
      update: async () => ({ ...failed, status: 'QUEUED', attempt: 2 }),
    },
  };
  const service = new EarningsGenerationService(
    prisma as any,
    { discoverAndIngest: async () => { sourceCalls += 1; } } as any,
    { schedule: (id: string) => scheduled.push(id) } as any,
  );

  const result = await service.retry('user-1', failed.id);

  assert.equal(result.status, 'QUEUED');
  assert.deepEqual(scheduled, [failed.id]);
  assert.equal(sourceCalls, 0);
});

test('consistency-check retry reports a conflict when no alternate source exists', async () => {
  const failed = {
    id: 'run-failed',
    stockId: 'stock-1',
    stock: { id: 'stock-1', symbol: '0700', market: 'HK' },
    status: 'FAILED',
    retryable: true,
    errorCode: 'CHECK_REJECTED_ALL',
    sourceDescriptor: { sourceGroupId: 'annual-group' },
  };
  const service = new EarningsGenerationService(
    {
      watchlistItem: { count: async () => 1 },
      earningsGenerationRun: { findUnique: async () => failed },
    } as any,
    {
      discoverAndIngest: async () => {
        throw new EarningsSourceError('NO_NEW_ELIGIBLE_FILING', true);
      },
    } as any,
    { schedule: () => undefined } as any,
  );

  await assert.rejects(
    () => service.retry('user-1', failed.id),
    (error: unknown) => {
      assert.ok(error instanceof ConflictException);
      assert.deepEqual(error.getResponse(), {
        code: 'NO_NEW_ELIGIBLE_FILING',
        retryable: true,
        message: 'NO_NEW_ELIGIBLE_FILING',
      });
      return true;
    },
  );
});
