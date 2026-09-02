import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { HomepageService } from './homepage.service';

const date = (value: string) => new Date(`${value}T00:00:00.000Z`);

function stock(id: string, symbol: string, market = 'US') {
  return {
    id,
    symbol,
    name: `${symbol} Inc.`,
    market,
    exchange: market === 'US' ? 'NASDAQ' : 'SSE',
    currency: market === 'US' ? 'USD' : 'CNY',
    yahooSymbol: symbol,
    sector: null,
    createdAt: date('2025-01-01'),
    updatedAt: date('2025-01-01'),
  };
}

function watchlistItem(id: string, stockId: string, createdAt: Date, stockRow: ReturnType<typeof stock>) {
  return {
    id,
    userId: 'user-1',
    stockId,
    notes: null,
    order: 0,
    createdAt,
    updatedAt: createdAt,
    stock: stockRow,
  };
}

function latestResearch(input: {
  id: string;
  capturedAt?: Date;
  completedAt?: Date;
  dataAsOf?: string;
}) {
  return {
    id: input.id,
    overallSignal: 'POSITIVE' as const,
    overallConfidence: 'HIGH' as const,
    dataAsOf: input.dataAsOf ?? '2026-08-10',
    completedAt: input.completedAt ?? date('2026-08-10'),
    evidenceSnapshot: input.capturedAt ? { capturedAt: input.capturedAt } : null,
  };
}

describe('HomepageService', () => {
  it('uses per-stock baselines, suppresses filings linked to a current earnings card, and scopes every query', async () => {
    const stockA = stock('stock-a', 'AAPL');
    const stockB = stock('stock-b', '600519', 'CN');
    const stockC = stock('stock-c', '0700', 'HK');
    const watchlist = [
      watchlistItem('wl-a', stockA.id, date('2026-07-01'), stockA),
      watchlistItem('wl-b', stockB.id, date('2026-08-01'), stockB),
      watchlistItem('wl-c', stockC.id, date('2026-07-15'), stockC),
    ];
    const latest = new Map([
      [stockA.id, latestResearch({ id: 'analysis-a', capturedAt: date('2026-08-10') })],
      [stockB.id, null],
      [
        stockC.id,
        latestResearch({
          id: 'analysis-c',
          completedAt: date('2026-08-05'),
          dataAsOf: '2026-08-04',
        }),
      ],
    ]);
    const calls: Array<{ name: string; args: any }> = [];
    let eventQueryCount = 0;

    const prisma = {
      watchlistItem: {
        findMany: async (args: any) => {
          calls.push({ name: 'watchlist', args });
          return watchlist;
        },
      },
      analysis: {
        findFirst: async (args: any) => {
          calls.push({ name: 'latest', args });
          return latest.get(args.where.stockId) ?? null;
        },
        findMany: async (args: any) => {
          calls.push({ name: 'recent', args });
          return [
            {
              id: 'recent-1',
              userId: 'user-1',
              stockId: stockA.id,
              symbol: stockA.symbol,
              market: stockA.market,
              mode: 'QUICK',
              focusWindow: 'D90',
              status: 'COMPLETED',
              createdAt: date('2026-08-18'),
              stock: stockA,
            },
          ];
        },
      },
      filing: {
        findMany: async (args: any) => {
          eventQueryCount += 1;
          calls.push({ name: 'filings', args });
          return [
            {
              id: 'filing-linked',
              stockId: stockA.id,
              formType: '10-Q',
              title: 'Quarterly report',
              provider: 'SEC',
              publishedAt: date('2026-08-15'),
            },
            {
              id: 'filing-a-valid',
              stockId: stockA.id,
              formType: '8-K',
              title: 'Current report',
              provider: 'SEC',
              publishedAt: date('2026-08-14'),
            },
            {
              id: 'filing-a-before-baseline',
              stockId: stockA.id,
              formType: '8-K',
              title: 'Old report',
              provider: 'SEC',
              publishedAt: date('2026-08-09'),
            },
            {
              id: 'filing-b-valid',
              stockId: stockB.id,
              formType: '半年报',
              title: null,
              provider: 'CNINFO',
              publishedAt: date('2026-08-12'),
            },
            {
              id: 'filing-c-before-completed',
              stockId: stockC.id,
              formType: '公告',
              title: 'Earlier filing',
              provider: 'HKEX',
              publishedAt: date('2026-08-04'),
            },
            {
              id: 'filing-c-valid',
              stockId: stockC.id,
              formType: '公告',
              title: 'Later filing',
              provider: 'HKEX',
              publishedAt: date('2026-08-06'),
            },
          ];
        },
      },
      earningsCard: {
        findMany: async (args: any) => {
          eventQueryCount += 1;
          calls.push({ name: 'cards', args });
          return [
            {
              id: 'card-a',
              event: {
                stockId: stockA.id,
                periodType: 'Q2',
                fiscalYear: 2026,
                filingLinks: [{ filingId: 'filing-linked' }],
              },
              currentRevision: {
                id: 'revision-a',
                revisionNo: 2,
                generatedAt: date('2026-08-16'),
              },
            },
            {
              id: 'card-b-old',
              event: {
                stockId: stockB.id,
                periodType: 'H1',
                fiscalYear: 2026,
                filingLinks: [],
              },
              currentRevision: {
                id: 'revision-b-old',
                revisionNo: 1,
                generatedAt: date('2026-07-31'),
              },
            },
          ];
        },
      },
    };

    const result = await new HomepageService(prisma as any).getBrief('user-1');

    assert.equal(result.watchlist[0]?.latestResearch?.analysisId, 'analysis-a');
    assert.equal(result.watchlist[1]?.latestResearch, null);
    assert.equal(result.recentAnalyses[0]?.focusWindow, '90D');
    assert.deepEqual(
      result.changes.map((change) => change.id),
      [
        'earnings:revision-a',
        'filing:filing-a-valid',
        'filing:filing-b-valid',
        'filing:filing-c-valid',
      ],
    );
    assert.equal(result.changes.some((change) => change.id.includes('filing-linked')), false);
    assert.match(result.changes[2]!.detail, /加入自选后发布/);
    assert.match(result.changes[3]!.detail, /上次研究之后/);
    assert.equal(eventQueryCount, 2);

    assert.deepEqual(calls.find((call) => call.name === 'watchlist')!.args.where, {
      userId: 'user-1',
    });
    for (const call of calls.filter((entry) => entry.name === 'latest')) {
      assert.equal(call.args.where.userId, 'user-1');
      assert.deepEqual(call.args.where.status.in, ['COMPLETED', 'PARTIAL_FAILED']);
    }
    assert.equal(calls.find((call) => call.name === 'recent')!.args.where.userId, 'user-1');
    assert.deepEqual(calls.find((call) => call.name === 'filings')!.args.where.stockId.in, [
      stockA.id,
      stockB.id,
      stockC.id,
    ]);
    assert.deepEqual(calls.find((call) => call.name === 'cards')!.args.where.event.stockId.in, [
      stockA.id,
      stockB.id,
      stockC.id,
    ]);
  });

  it('keeps the response bounded and reports when more watchlist rows exist', async () => {
    const watchlist = Array.from({ length: 11 }, (_, index) => {
      const row = stock(`stock-${index}`, `S${index}`);
      return watchlistItem(`wl-${index}`, row.id, date('2026-01-01'), row);
    });
    const calls: Array<{ name: string; args: any }> = [];
    const prisma = {
      watchlistItem: {
        findMany: async (args: any) => {
          calls.push({ name: 'watchlist', args });
          return watchlist;
        },
      },
      analysis: {
        findFirst: async () => null,
        findMany: async (args: any) => {
          calls.push({ name: 'recent', args });
          return [];
        },
      },
      filing: {
        findMany: async (args: any) => {
          calls.push({ name: 'filings', args });
          return Array.from({ length: 7 }, (_, index) => ({
            id: `filing-${index}`,
            stockId: watchlist[0]!.stockId,
            formType: '8-K',
            title: `Filing ${index}`,
            provider: 'SEC',
            publishedAt: date(`2026-08-${String(19 - index).padStart(2, '0')}`),
          }));
        },
      },
      earningsCard: {
        findMany: async (args: any) => {
          calls.push({ name: 'cards', args });
          return [];
        },
      },
    };

    const result = await new HomepageService(prisma as any).getBrief('user-1');

    assert.equal(result.watchlist.length, 10);
    assert.equal(result.hasMoreWatchlist, true);
    assert.equal(result.changes.length, 5);
    assert.equal(calls.find((call) => call.name === 'watchlist')!.args.take, 11);
    assert.equal(calls.find((call) => call.name === 'recent')!.args.take, 5);
    assert.equal(calls.find((call) => call.name === 'filings')!.args.take, 50);
    assert.equal(calls.find((call) => call.name === 'cards')!.args.take, 50);
  });

  it('skips global event queries when the user has no watchlist', async () => {
    let eventQueryCount = 0;
    const recentStock = stock('stock-recent', 'MSFT');
    const prisma = {
      watchlistItem: { findMany: async () => [] },
      analysis: {
        findFirst: async () => null,
        findMany: async () => [
          {
            id: 'recent-1',
            mode: 'DEEP',
            focusWindow: 'Y1',
            status: 'FAILED',
            createdAt: date('2026-08-10'),
            stock: recentStock,
          },
        ],
      },
      filing: {
        findMany: async () => {
          eventQueryCount += 1;
          return [];
        },
      },
      earningsCard: {
        findMany: async () => {
          eventQueryCount += 1;
          return [];
        },
      },
    };

    const result = await new HomepageService(prisma as any).getBrief('user-1');

    assert.deepEqual(result.watchlist, []);
    assert.deepEqual(result.changes, []);
    assert.equal(result.recentAnalyses[0]?.focusWindow, '1Y');
    assert.equal(eventQueryCount, 0);
  });
});
