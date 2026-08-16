import { describe, expect, it } from 'vitest';
import type { MarketDataToolDescriptor } from './types';
import type { AkshareNorthboundInput, AkshareNorthboundOutput } from './akshare-northbound';
import type { UnlockCalendarInput, UnlockCalendarOutput } from './unlock-calendar';
import {
  createCnPublicMarketEventsConnector,
  createCnPublicOwnershipConnector,
} from './canonical';

const stockConnectTool: MarketDataToolDescriptor<AkshareNorthboundInput, AkshareNorthboundOutput> = {
  name: 'stock-connect-fixture',
  description: 'fixture',
  providerInternal: false,
  async run() {
    return {
      data: {
        sourceMirror: 'fixture',
        rows: [{
          date: '2026-07-29',
          hgt: 1.25,
          sgt: -0.5,
          holdShares: 12.5,
          holdMarketValue: 3.4,
          holdPctOfFloat: 0.02,
        }],
      },
      citations: [{
        title: 'Stock Connect fixture',
        url: 'https://example.test/stock-connect',
        sourceType: 'OTHER',
        retrievedAt: '2026-07-30T00:00:00.000Z',
      }],
      cost: { tokensIn: 0, tokensOut: 0 },
      trace: { source: 'fixture' },
    };
  },
};

const unlockTool: MarketDataToolDescriptor<UnlockCalendarInput, UnlockCalendarOutput> = {
  name: 'unlock-fixture',
  description: 'fixture',
  providerInternal: false,
  async run() {
    return {
      data: { events: [{ date: '2026-08-01', shares: 5_000_000, marketValue: 1.2, type: '定增' }] },
      citations: [{
        title: 'Unlock fixture',
        url: 'https://example.test/unlock',
        sourceType: 'OTHER',
        retrievedAt: '2026-07-30T00:00:00.000Z',
      }],
      cost: { tokensIn: 0, tokensOut: 0 },
      trace: { source: 'fixture' },
    };
  },
};

describe('CN canonical connector adapters', () => {
  it('normalizes stock-connect rows into typed ownership observations', async () => {
    const connector = createCnPublicOwnershipConnector({ stockConnect: stockConnectTool });

    const result = await connector.listOwnership({
      instrumentId: 'CN:600519',
      dataSet: 'stock-connect',
      limit: 20,
    });

    expect(result.data).toEqual(expect.arrayContaining([expect.objectContaining({
      kind: 'STOCK_CONNECT',
      asOf: '2026-07-29',
      shanghaiNetFlow: '1.25',
      shenzhenNetFlow: '-0.5',
      flowUnit: 'CNY_100M',
    }), expect.objectContaining({
      kind: 'STOCK_CONNECT_HOLDING',
      asOf: '2026-07-29',
      holdingShares: '12.5',
      holdingPercentOfFloat: '0.02',
    })]));
    expect(result.citations[0]).toEqual(expect.objectContaining({ provider: 'fixture' }));
    expect(result.freshness[0]).toEqual(expect.objectContaining({ asOf: '2026-07-29T00:00:00.000Z' }));
  });

  it('normalizes unlock market value from 100M CNY into base CNY', async () => {
    const connector = createCnPublicMarketEventsConnector({ unlock: unlockTool });

    const result = await connector.listEvents({
      instrumentId: 'CN:600519',
      dataSet: 'unlock',
      limit: 90,
    });

    expect(result.data).toEqual([expect.objectContaining({
      type: 'UNLOCK',
      shares: '5000000',
      marketValue: '120000000',
      currency: 'CNY',
      unlockType: '定增',
    })]);
  });

  it('rejects non-CN canonical instrument ids before calling a tool', async () => {
    const connector = createCnPublicOwnershipConnector({ stockConnect: stockConnectTool });

    await expect(connector.listOwnership({
      instrumentId: 'US:AAPL',
      dataSet: 'stock-connect',
    })).rejects.toThrow('unsupported instrument');
  });
});
