import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildEarningsGenerationIdempotencyKey,
  detectedRetryAt,
  EarningsGenerationService,
} from './earnings-generation.service';
import type { PreparedEarningsSource, StructuredFallbackSource } from './earnings-source.service';

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

test('structured fallback reasons have separate idempotency identities', () => {
  const fallback: StructuredFallbackSource = {
    kind: 'structuredFallback',
    provider: 'sec-edgar',
    sourceDocumentId: 'accession:release.htm',
    formType: '8-K',
    sourceUrl: 'https://example.com/release.htm',
    publishedAt: '2026-01-01T00:00:00.000Z',
    reason: 'LLM_DISABLED',
  };
  assert.notEqual(
    buildEarningsGenerationIdempotencyKey('stock-1', fallback),
    buildEarningsGenerationIdempotencyKey('stock-1', {
      ...fallback,
      reason: 'PROVIDER_UNAVAILABLE',
    }),
  );
});

test('detected failures back off while budget exhaustion waits for the next UTC day', () => {
  const completedAt = new Date('2026-07-21T23:58:00.000Z');
  assert.equal(
    detectedRetryAt('FAILED', 1, completedAt).toISOString(),
    '2026-07-22T00:03:00.000Z',
  );
  assert.equal(
    detectedRetryAt('FAILED', 2, completedAt).toISOString(),
    '2026-07-22T00:08:00.000Z',
  );
  assert.equal(
    detectedRetryAt('BUDGET_EXHAUSTED', 9, completedAt).toISOString(),
    '2026-07-22T00:00:00.000Z',
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
    { get: () => undefined } as any,
  );

  const run = await service.createDetected('stock-1');

  assert.equal(run?.status, 'QUEUED');
  assert.deepEqual(scheduled, ['run-1']);
  assert.equal(sourceCalls, 0);
});

test('feature flag stops detector work before any database or upstream access', async () => {
  let accessed = false;
  const service = new EarningsGenerationService(
    { stock: { findUnique: async () => { accessed = true; } } } as any,
    { discoverAndIngest: async () => { accessed = true; } } as any,
    { schedule: () => { accessed = true; } } as any,
    { get: (key: string) => key === 'EARNINGS_BRIEF_ENABLED' ? 'false' : undefined } as any,
  );

  assert.equal(await service.createDetected('stock-1'), null);
  assert.equal(accessed, false);
});
