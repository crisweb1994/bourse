import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { WatchlistService } from './watchlist.service';

/**
 * Ownership + conflict semantics (KISS review A7): the @@unique(userId, stockId)
 * race-free add and the ownership-scoped update/remove paths.
 */

const addDto = {
  symbol: 'AAPL',
  name: 'Apple',
  market: 'US',
  exchange: 'NASDAQ',
  currency: 'USD',
} as any;

describe('WatchlistService · add', () => {
  it('maps a P2002 unique violation to 409 ConflictException', async () => {
    const prisma = {
      watchlistItem: {
        create: async () => {
          throw new Prisma.PrismaClientKnownRequestError('duplicate', {
            code: 'P2002',
            clientVersion: 'test',
          });
        },
      },
    };
    const stockService = { upsert: async () => ({ id: 'stock-1' }) };
    const svc = new WatchlistService(prisma as any, stockService as any);
    await assert.rejects(
      () => svc.add('u1', addDto),
      ConflictException,
    );
  });

  it('rethrows non-P2002 errors unchanged', async () => {
    const prisma = {
      watchlistItem: {
        create: async () => {
          throw new Prisma.PrismaClientKnownRequestError('fk violation', {
            code: 'P2003',
            clientVersion: 'test',
          });
        },
      },
    };
    const stockService = { upsert: async () => ({ id: 'stock-1' }) };
    const svc = new WatchlistService(prisma as any, stockService as any);
    await assert.rejects(
      () => svc.add('u1', addDto),
      (err: unknown) =>
        err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2003',
    );
  });
});

describe('WatchlistService · update ownership', () => {
  it('scopes the lookup by (id, userId) and 404s when the row is absent', async () => {
    const captured: { where?: any } = {};
    const prisma = {
      watchlistItem: {
        findFirst: async (args: any) => {
          captured.where = args.where;
          return null;
        },
      },
    };
    const svc = new WatchlistService(prisma as any, {} as any);
    await assert.rejects(
      () => svc.update('u1', 'item-1', { notes: 'x' } as any),
      NotFoundException,
    );
    assert.deepEqual(captured.where, { id: 'item-1', userId: 'u1' });
  });

  it('returns the updated row including stock on the happy path', async () => {
    const prisma = {
      watchlistItem: {
        findFirst: async () => ({ id: 'item-1', userId: 'u1' }),
        update: async (args: any) => ({
          id: 'item-1',
          notes: args.data.notes,
          stock: { symbol: 'AAPL' },
        }),
      },
    };
    const svc = new WatchlistService(prisma as any, {} as any);
    const row = await svc.update('u1', 'item-1', { notes: 'watch' } as any);
    assert.equal(row.notes, 'watch');
    assert.equal(row.stock.symbol, 'AAPL');
  });
});

describe('WatchlistService · remove ownership', () => {
  it('deletes ownership-scoped and 404s when nothing matched', async () => {
    const captured: { where?: any } = {};
    const prisma = {
      watchlistItem: {
        deleteMany: async (args: any) => {
          captured.where = args.where;
          return { count: 0 };
        },
      },
    };
    const svc = new WatchlistService(prisma as any, {} as any);
    await assert.rejects(
      () => svc.remove('u1', 'item-1'),
      NotFoundException,
    );
    assert.deepEqual(captured.where, { id: 'item-1', userId: 'u1' });
  });

  it('returns ok when exactly the owned row was deleted', async () => {
    const prisma = {
      watchlistItem: {
        deleteMany: async () => ({ count: 1 }),
      },
    };
    const svc = new WatchlistService(prisma as any, {} as any);
    assert.deepEqual(await svc.remove('u1', 'item-1'), { ok: true });
  });
});
