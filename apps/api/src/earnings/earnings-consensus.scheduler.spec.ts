import assert from 'node:assert/strict';
import test from 'node:test';
import { EarningsConsensusScheduler } from './earnings-consensus.scheduler';

test('consensus scheduler covers the watchlist union with fixed bounded concurrency', async () => {
  const stocks = Array.from({ length: 12 }, (_, index) => ({
    id: `stock-${index}`,
    symbol: `S${index}`,
    market: index % 2 === 0 ? 'US' : 'CN',
  }));
  let active = 0;
  let maxActive = 0;
  let captured = 0;
  const scheduler = new EarningsConsensusScheduler(
    { stock: { findMany: async () => stocks } } as any,
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
  assert.equal(maxActive, 5);
});
