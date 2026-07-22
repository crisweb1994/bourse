import test from 'node:test';
import assert from 'node:assert/strict';
import type { EarningsCardPayload } from '@bourse/analysis';
import { Prisma } from '@prisma/client';
import { EarningsNoticeService } from './earnings-notice.service';

const PAYLOAD: EarningsCardPayload = {
  schemaVersion: 'earnings-card-v2',
  event: {
    instrumentId: 'US:AAPL',
    periodEndOn: '2026-03-28',
    periodType: 'Q2',
    fiscalYear: 2026,
    fiscalQuarter: 2,
    reportingScope: 'consolidated',
  },
  filing: {
    sourceKind: 'filing',
    filingId: 'filing-1',
    formType: '8-K',
    sourceUrl: 'https://example.com/filing',
    publishedAt: '2026-04-20T20:00:00.000Z',
    provider: 'sec-edgar',
    unaudited: true,
  },
  supportingFilings: [],
  facts: [],
  managementClaims: [],
  omittedFactCount: 0,
  statusSummary: { total: 0, reconciled: 0, pending: 0, conflicted: 0, structuredOnly: 0 },
  generatedAt: '2026-04-20T20:05:00.000Z',
};

test('earnings notice does nothing without explicit immediate-notice opt-in', async () => {
  let writes = 0;
  const prisma = {
    stock: {
      findUnique: async () => ({
        id: 'stock-1', symbol: 'AAPL', name: 'Apple', market: 'US',
        watchlistItems: [{
          userId: 'user-1',
          user: { digestSubscription: { enabled: true, earningsImmediateEnabled: false, channels: [] } },
        }],
      }),
    },
    earningsDeliveryRecord: {
      create: async () => { writes += 1; },
      updateMany: async () => ({ count: 0 }),
    },
  };
  const service = new EarningsNoticeService(prisma as any);
  await service.notify('stock-1', PAYLOAD, 'revision-1', undefined, 'NEW_CARD');
  assert.equal(writes, 0);
});

test('earnings notice uses revision and correction kind in the delivery dedupe key', async () => {
  let dedupeKey = '';
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('{}', { status: 200 });
  const prisma = {
    stock: {
      findUnique: async () => ({
        id: 'stock-1', symbol: 'AAPL', name: 'Apple', market: 'US',
        watchlistItems: [{
          userId: 'user-1',
          user: {
            digestSubscription: {
              enabled: true,
              earningsImmediateEnabled: true,
              markets: ['US'],
              channels: [{ type: 'FEISHU', url: 'https://example.com/hook' }],
            },
          },
        }],
      }),
    },
    earningsDeliveryRecord: {
      create: async (args: any) => { dedupeKey = args.data.dedupeKey; },
      updateMany: async () => ({ count: 0 }),
      upsert: async () => undefined,
    },
  };
  try {
    const service = new EarningsNoticeService(prisma as any);
    await service.notify('stock-1', PAYLOAD, 'revision-2', 'revision-1', 'CORRECTION');
    assert.equal(dedupeKey, 'user-1:revision-2:CORRECTION:FEISHU:example.com');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('earnings notice atomically claims a delivery across concurrent workers', async () => {
  let created = false;
  const prisma = {
    earningsDeliveryRecord: {
      create: async () => {
        if (!created) {
          created = true;
          return {};
        }
        throw new Prisma.PrismaClientKnownRequestError('duplicate', {
          code: 'P2002',
          clientVersion: 'test',
        });
      },
      updateMany: async () => ({ count: 0 }),
    },
  };
  const service = new EarningsNoticeService(prisma as any);
  const notice = {
    stockId: 'stock-1',
    revisionId: 'revision-1',
    kind: 'NEW_CARD',
  } as any;
  const channel = { type: 'FEISHU', url: 'https://example.com/hook' };
  const results = await Promise.all([
    (service as any).claimDelivery('same-key', 'user-1', channel, notice),
    (service as any).claimDelivery('same-key', 'user-1', channel, notice),
  ]);
  assert.deepEqual(results.sort(), [false, true]);
});
