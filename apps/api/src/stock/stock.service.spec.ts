import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { StockSearchResult } from '@bourse/shared-types';
import { createBuiltInSources, createResearchMarketDataClient } from '@bourse/market-data';
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
  eastMoney?: (query: string) => Promise<StockSearchResult[]>;
  tencent?: (query: string) => Promise<StockSearchResult[]>;
  yahoo?: (query: string) => Promise<StockSearchResult[]>;
}) {
  return new StockService(
    {} as never,
    createResearchMarketDataClient(createBuiltInSources({
      instrumentSearch: [
        { search: options?.eastMoney ?? (async () => []) },
        { search: options?.tencent ?? (async () => []) },
        { search: options?.yahoo ?? (async () => []) },
      ],
    } as never)),
    {} as never,
  );
}

test('stock search merges Tencent and Yahoo candidates after East Money is empty', async () => {
  let yahooCalls = 0;
  const service = createService({
    tencent: async () => [AAPL],
    yahoo: async () => {
      yahooCalls += 1;
      return [];
    },
  });

  assert.deepEqual(await service.search('AAPL'), [AAPL]);
  assert.equal(yahooCalls, 1);
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

test('stock detail normalizes a CN Yahoo symbol before candidate recovery', async () => {
  const queries: string[] = [];
  const moutai: StockSearchResult = {
    symbol: '600519',
    name: 'Kweichow Moutai',
    market: 'CN',
    exchange: 'SSE',
    currency: 'CNY',
    yahooSymbol: '600519.SS',
  };
  const service = createService({
    eastMoney: async (query) => {
      queries.push(query);
      return [moutai];
    },
  });
  (service as any).prisma = {
    stock: { findUnique: async () => null, findFirst: async () => null },
  };

  const detail = await service.getDetail('600519.SS', 'CN');

  assert.deepEqual(detail.candidates, [moutai]);
  assert.deepEqual(queries, ['600519']);
});

test('stock detail filters ambiguous recovery candidates by requested market', async () => {
  const hk: StockSearchResult = {
    symbol: '0700',
    name: 'Tencent',
    market: 'HK',
    exchange: 'HKEX',
    currency: 'HKD',
    yahooSymbol: '0700.HK',
  };
  const cn: StockSearchResult = {
    symbol: '000700',
    name: 'Mosu Technology',
    market: 'CN',
    exchange: 'SZSE',
    currency: 'CNY',
    yahooSymbol: '000700.SZ',
  };
  const service = createService({ eastMoney: async () => [hk, cn] });
  (service as any).prisma = {
    stock: { findUnique: async () => null, findFirst: async () => null },
  };

  const detail = await service.getDetail('0700.HK', 'HK');

  assert.deepEqual(detail.candidates, [hk]);
});

test('stock detail consumes canonical quote units without market-specific compensation', async () => {
  const stock = {
    id: 'stock-cn',
    symbol: '600519',
    market: 'CN',
    name: 'Kweichow Moutai',
    exchange: 'SSE',
    currency: 'CNY',
    yahooSymbol: '600519.SS',
  };
  const service = new StockService(
    {
      stock: {
        findUnique: async () => stock,
        findFirst: async () => null,
      },
    } as never,
    {
      getQuote: async () => ({
        data: {
          instrument: { instrumentId: 'CN:600519', market: 'CN', symbol: '600519' },
          price: 1_685,
          change: 23.67,
          changePct: 1.42,
          previousClose: 1_661.33,
          marketCap: 2_100_000_000_000,
          currency: 'CNY',
          timestamp: '2026-07-29T07:00:00.000Z',
        },
        warnings: [],
      }),
    } as never,
    {} as never,
  );

  const detail = await service.getDetail('600519', 'CN');

  assert.equal(detail.quote?.degraded, false);
  assert.equal(detail.quote && !detail.quote.degraded ? detail.quote.changePct : null, 1.42);
  assert.equal(
    detail.profile && !detail.profile.degraded ? detail.profile.marketCap : null,
    2_100_000_000_000,
  );
});
