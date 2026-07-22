import assert from 'node:assert/strict';
import test from 'node:test';
import { EarningsConsensusScheduler } from './earnings-consensus.scheduler';

test('consensus scheduler skips work while another replica owns the lease', async () => {
  let stockReads = 0;
  const tx = {
    $executeRaw: async () => 1,
    earningsSchedulerLease: {
      findUnique: async () => ({ leaseUntil: new Date(Date.now() + 60_000) }),
      upsert: async () => ({}),
    },
  };
  const prisma = {
    $transaction: async (fn: any) => fn(tx),
    stock: { findMany: async () => { stockReads += 1; return []; } },
    earningsSchedulerLease: { updateMany: async () => ({ count: 0 }) },
  };
  const scheduler = new EarningsConsensusScheduler(
    prisma as any,
    { get: () => undefined } as any,
    { capture: async () => 0 } as any,
  );

  await scheduler.tick();

  assert.equal(stockReads, 0);
});

test('consensus scheduler covers the full watchlist union with bounded concurrency', async () => {
  const stocks = Array.from({ length: 12 }, (_, index) => ({
    id: `stock-${index}`,
    symbol: `S${index}`,
    market: index % 2 === 0 ? 'US' : 'CN',
  }));
  let active = 0;
  let maxActive = 0;
  let captured = 0;
  let renewals = 0;
  const tx = {
    $executeRaw: async () => 1,
    earningsSchedulerLease: {
      findUnique: async () => null,
      upsert: async () => ({}),
    },
  };
  const prisma = {
    $transaction: async (fn: any) => fn(tx),
    stock: { findMany: async () => stocks },
    earningsSchedulerLease: {
      updateMany: async (args: any) => {
        if (args.data.ownerToken === undefined) renewals += 1;
        return { count: 1 };
      },
    },
  };
  const scheduler = new EarningsConsensusScheduler(
    prisma as any,
    { get: (key: string) => key === 'EARNINGS_CONSENSUS_CONCURRENCY' ? '3' : undefined } as any,
    {
      capture: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 2));
        active -= 1;
        captured += 1;
        return 1;
      },
    } as any,
  );

  await scheduler.tick();

  assert.equal(captured, stocks.length);
  assert.equal(maxActive, 3);
  assert.equal(renewals, 4);
});
