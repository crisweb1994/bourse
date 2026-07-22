import test from 'node:test';
import assert from 'node:assert/strict';
import { Prisma } from '@prisma/client';
import { EarningsConsensusService } from './earnings-consensus.service';

const STOCK = {
  id: 'stock-aapl',
  symbol: 'AAPL',
  name: 'Apple',
  market: 'US',
  exchange: 'NASDAQ',
  currency: 'USD',
  yahooSymbol: null,
  sector: null,
  createdAt: new Date(),
  updatedAt: new Date(),
} as const;

test('consensus capture persists an auditable pre-publication snapshot', async () => {
  let upsert: any;
  const prisma = {
    earningsConsensusSnapshot: {
      upsert: async (args: any) => {
        upsert = args;
        return args.create;
      },
    },
  };
  const yahoo = {
    fetchEarningsConsensus: async () => ({
      schemaVersion: '1.0' as const,
      data: {
        asOf: '2026-01-20T12:00:00.000Z',
        estimates: [{
          metricCode: 'epsBasic' as const,
          periodEndOn: '2026-03-28',
          periodType: 'QUARTER' as const,
          value: '1.62',
          unit: 'per_share' as const,
          currency: 'USD',
          analystCount: 25,
        }],
      },
      citations: [{
        title: 'Yahoo consensus',
        url: 'https://finance.yahoo.com/quote/AAPL/analysis/',
        sourceType: 'OTHER' as const,
        provider: 'yahoo',
        retrievedAt: '2026-01-20T12:00:00.000Z',
        qualityTier: 'B' as const,
      }],
      freshness: [],
      warnings: [],
    }),
  };
  const service = new EarningsConsensusService(
    prisma as any,
    { get: () => undefined } as any,
    {} as any,
    yahoo as any,
  );

  assert.equal(await service.capture(STOCK as any), 1);
  assert.equal(upsert.create.periodType, 'QUARTER');
  assert.equal(upsert.create.value.toString(), '1.62');
  assert.equal(upsert.create.provider, 'yahoo');
  assert.ok(upsert.create.capturedAt instanceof Date);
  assert.deepEqual(upsert.update, {});
});

test('consensus query enforces asOf and capturedAt before publication', async () => {
  let where: any;
  const prisma = {
    earningsConsensusSnapshot: {
      findMany: async (args: any) => {
        where = args.where;
        return [{
          id: 'snapshot-1',
          stockId: 'stock-aapl',
          metricCode: 'epsBasic',
          periodEndOn: new Date('2026-03-28T00:00:00.000Z'),
          periodType: 'QUARTER',
          value: new Prisma.Decimal('1.62'),
          unit: 'per_share',
          currency: 'USD',
          asOf: new Date('2026-01-20T12:00:00.000Z'),
          capturedAt: new Date('2026-01-20T12:05:00.000Z'),
          provider: 'yahoo',
          sourceUrl: 'https://finance.yahoo.com/quote/AAPL/analysis/',
          analystCount: 25,
          expiresAt: new Date('2026-02-19T12:00:00.000Z'),
        }];
      },
    },
  };
  const service = new EarningsConsensusService(
    prisma as any,
    { get: () => undefined } as any,
    {} as any,
    {} as any,
  );
  const publishedAt = '2026-02-01T12:00:00.000Z';
  const rows = await service.beforePublication('stock-aapl', '2026-03-28', 'epsBasic', publishedAt);

  assert.equal(where.asOf.lt.toISOString(), publishedAt);
  assert.equal(where.capturedAt.lt.toISOString(), publishedAt);
  assert.equal(rows[0]?.value.value, '1.62');
});
