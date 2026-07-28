import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { StockSearchResult } from '@bourse/shared-types';
import { MarketDataClient } from '@bourse/market-data';
import { StockService } from './stock.service';

const AAPL: StockSearchResult = {
  symbol: 'AAPL',
  name: 'Apple',
  market: 'US',
  exchange: 'NASDAQ',
  currency: 'USD',
  yahooSymbol: 'AAPL',
};

function createService(options?: {
  eastMoney?: () => Promise<StockSearchResult[]>;
  tencent?: () => Promise<StockSearchResult[]>;
  yahoo?: () => Promise<StockSearchResult[]>;
}) {
  return new StockService(
    {} as never,
    new MarketDataClient({
      instrumentSearch: [
        { search: options?.eastMoney ?? (async () => []) },
        { search: options?.tencent ?? (async () => []) },
        { search: options?.yahoo ?? (async () => []) },
      ],
    } as never),
  );
}

test('stock search falls back from East Money to Tencent before Yahoo', async () => {
  let yahooCalls = 0;
  const service = createService({
    tencent: async () => [AAPL],
    yahoo: async () => {
      yahooCalls += 1;
      return [];
    },
  });

  assert.deepEqual(await service.search('AAPL'), [AAPL]);
  assert.equal(yahooCalls, 0);
});

test('stock search does not cache an all-provider empty result', async () => {
  let calls = 0;
  const service = createService({
    tencent: async () => {
      calls += 1;
      return calls === 1 ? [] : [AAPL];
    },
  });

  assert.deepEqual(await service.search('AAPL'), []);
  assert.deepEqual(await service.search('AAPL'), [AAPL]);
  assert.equal(calls, 2);
});
