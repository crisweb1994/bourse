import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  BadRequestException,
  HttpException,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  ScreeningRunDtoSchema,
  type EquityScreenerSnapshot,
  type ScreeningQuery,
} from '@bourse/shared-types';
import type { ResearchResultV2 } from '@bourse/market-data';
import { ScreeningService } from './screening.service';

const PERSISTABLE_CONSTRAINTS = {
  acceptedRedistribution: [
    'public-cache-allowed',
    'credential-cache-only',
  ],
};

const QUERY: ScreeningQuery = {
  market: 'CN',
  universe: 'ACTIVE_COMMON_STOCKS',
  conditions: [{ metric: 'MARKET_CAP', operator: 'GTE', value: 1_000_000 }],
  sort: { metric: 'MARKET_CAP', direction: 'DESC' },
};

const CELL = {
  status: 'PRESENT' as const,
  value: 2_000_000,
  unit: 'CURRENCY' as const,
  sourceId: 'cn-screener',
  asOf: '2026-08-22T00:00:00.000Z',
  estimated: false,
};

const MISSING_CELL = {
  status: 'MISSING' as const,
  value: null,
  unit: 'RATIO' as const,
  sourceId: 'cn-screener',
  asOf: '2026-08-22T00:00:00.000Z',
  estimated: false,
};

function snapshot(keys: string[] = ['CN:600000']): EquityScreenerSnapshot {
  return {
    universeCount: 5_000,
    matchedCount: keys.length,
    providerAsOf: '2026-08-22T00:00:00.000Z',
    complete: true,
    truncated: false,
    conditionCounts: [keys.length],
    warnings: [],
    items: keys.map((identityKey) => ({
      identityKey,
      symbol: identityKey.slice(3),
      name: `Stock ${identityKey}`,
      exchange: 'SSE',
      currency: 'CNY',
      metrics: {
        MARKET_CAP: CELL,
        NET_INCOME_TTM: { ...MISSING_CELL, unit: 'CURRENCY' },
        PE_TTM: MISSING_CELL,
        PB: MISSING_CELL,
        REVENUE_GROWTH_YOY: { ...MISSING_CELL, unit: 'PERCENT' },
        PRICE: { ...MISSING_CELL, unit: 'CURRENCY' },
        CHANGE_PCT: { ...MISSING_CELL, unit: 'PERCENT' },
        TURNOVER_RATE: { ...MISSING_CELL, unit: 'PERCENT' },
      },
      matchedConditionIndexes: [0],
    })),
  };
}

function ok<T>(
  data: T,
  sourceId = 'cn-screener',
  warnings: ResearchResultV2<T>['warnings'] = [],
): ResearchResultV2<T> {
  return {
    schemaVersion: '2.0',
    status: 'ok',
    data,
    citations: [],
    freshness: [],
    warnings,
    trace: { selectedSource: sourceId, attempts: [] },
  };
}

function partial<T>(
  data: T,
  sourceId: string,
  warnings: ResearchResultV2<T>['warnings'] = [],
): ResearchResultV2<T> {
  return {
    schemaVersion: '2.0',
    status: 'partial',
    data,
    citations: [],
    freshness: [],
    warnings,
    trace: { selectedSource: sourceId, attempts: [] },
  };
}

function failed<T>(
  code:
    | 'UNSUPPORTED_CAPABILITY'
    | 'SOURCE_UNAVAILABLE'
    | 'PERMISSION_DENIED'
    | 'RATE_LIMITED' = 'SOURCE_UNAVAILABLE',
  message: string = code,
): ResearchResultV2<T> {
  return {
    schemaVersion: '2.0',
    status: 'failed',
    data: null,
    citations: [],
    freshness: [],
    warnings: [],
    trace: { attempts: [] },
    error: { code, message },
  };
}

const DESCRIPTOR = {
  market: 'CN' as const,
  metrics: [
    {
      metric: 'MARKET_CAP' as const,
      operators: ['GTE', 'LTE', 'BETWEEN'] as const,
    },
  ],
  sortableMetrics: ['MARKET_CAP'] as const,
  delay: 'realtime' as const,
  universeLabel: 'A-share active common stocks',
  universeRules: ['active common stocks'],
};

function refinementPrisma(
  runSnapshot: EquityScreenerSnapshot,
  options: {
    existing?: string[];
    onUpsert?: (args: any) => Promise<any>;
  } = {},
) {
  const rows = new Map<string, unknown>(
    (options.existing ?? []).map((identityKey) => [identityKey, null]),
  );
  const placeholders: unknown[] = [];
  const tx = {
    $queryRaw: async () => [{
      id: 'run-1',
      query: QUERY,
      snapshot: runSnapshot,
    }],
    screeningRefinement: {
      findMany: async () => [...rows.keys()].map((identityKey) => ({ identityKey })),
      createMany: async (args: any) => {
        let count = 0;
        for (const row of args.data) {
          if (rows.has(row.identityKey)) continue;
          rows.set(row.identityKey, row.payload);
          placeholders.push(row.payload);
          count += 1;
        }
        return { count };
      },
    },
  };
  let transactionTail = Promise.resolve();
  const prisma = {
    $transaction: async (operation: (client: typeof tx) => Promise<unknown>) => {
      const previous = transactionTail;
      let release!: () => void;
      transactionTail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        return await operation(tx);
      } finally {
        release();
      }
    },
    screeningRefinement: {
      upsert: options.onUpsert ?? (async (args: any) => {
        rows.set(args.create.identityKey, args.update.payload);
        return {
          identityKey: args.create.identityKey,
          payload: args.update.payload,
          createdAt: new Date('2026-08-22T02:00:00.000Z'),
          updatedAt: new Date('2026-08-22T02:00:00.000Z'),
        };
      }),
    },
    screeningRun: {
      findFirst: async () => ({
        id: 'run-1',
        savedScreenId: null,
        query: QUERY,
        sourceId: 'cn-screener',
        capturedAt: new Date('2026-08-22T01:00:00.000Z'),
        snapshot: runSnapshot,
        createdAt: new Date('2026-08-22T01:00:00.000Z'),
        savedScreen: null,
        refinements: [...rows].map(([identityKey, payload]) => ({
          identityKey,
          payload,
          createdAt: new Date('2026-08-22T02:00:00.000Z'),
          updatedAt: new Date('2026-08-22T02:00:00.000Z'),
        })),
      }),
    },
  };
  return { prisma, rows, placeholders };
}

describe('ScreeningService', () => {
  it('uses persistence-safe routing constraints when loading config', async () => {
    let constraints: unknown;
    const service = new ScreeningService(
      {} as any,
      {
        describeEquityScreener: async (
          _market: string,
          _context: unknown,
          routeConstraints: unknown,
        ) => {
          constraints = routeConstraints;
          return failed('PERMISSION_DENIED');
        },
      } as any,
    );

    const config = await service.config('CN');

    assert.equal(config.available, false);
    assert.equal(
      config.unavailableReason,
      '当前筛选数据源不允许保存候选快照，因此未启用。',
    );
    assert.deepEqual(constraints, PERSISTABLE_CONSTRAINTS);
  });

  it('returns a stable 503 when only no-store screening sources exist', async () => {
    let creates = 0;
    let screenCalls = 0;
    const service = new ScreeningService(
      {
        screeningRun: {
          create: async () => {
            creates += 1;
          },
        },
      } as any,
      {
        describeEquityScreener: async () => failed('PERMISSION_DENIED'),
        screenEquities: async () => {
          screenCalls += 1;
          return ok(snapshot());
        },
      } as any,
    );

    await assert.rejects(
      () => service.createRun('user-1', { query: QUERY }),
      (error: unknown) => {
        assert.ok(error instanceof ServiceUnavailableException);
        assert.deepEqual(error.getResponse(), {
          message: '当前筛选数据源不允许保存候选快照，因此未启用。',
          code: 'SCREENER_PERSISTENCE_NOT_ALLOWED',
        });
        return true;
      },
    );
    assert.equal(screenCalls, 0);
    assert.equal(creates, 0);
  });

  it('returns 503 and does not create a run when no screener source exists', async () => {
    let creates = 0;
    let screenCalls = 0;
    let constraints: unknown;
    const service = new ScreeningService(
      {
        screeningRun: {
          create: async () => {
            creates += 1;
          },
        },
      } as any,
      {
        describeEquityScreener: async (
          _market: string,
          _context: unknown,
          routeConstraints: unknown,
        ) => {
          constraints = routeConstraints;
          return failed('UNSUPPORTED_CAPABILITY');
        },
        screenEquities: async () => {
          screenCalls += 1;
          return ok(snapshot());
        },
      } as any,
    );

    await assert.rejects(
      () => service.createRun('user-1', { query: QUERY }),
      ServiceUnavailableException,
    );
    assert.equal(creates, 0);
    assert.equal(screenCalls, 0);
    assert.deepEqual(constraints, PERSISTABLE_CONSTRAINTS);
  });

  it('never exposes an upstream provider error message', async () => {
    const sensitiveMessage =
      'request https://provider.test?apikey=secret failed';
    const cases = [
      {
        code: 'RATE_LIMITED' as const,
        status: 429,
        message: 'Screener provider is rate limited.',
      },
      {
        code: 'SOURCE_UNAVAILABLE' as const,
        status: 502,
        message: 'Screener provider did not return a usable snapshot.',
      },
    ];

    for (const testCase of cases) {
      const service = new ScreeningService(
        {} as any,
        {
          describeEquityScreener: async () => ok(DESCRIPTOR),
          screenEquities: async () =>
            failed(testCase.code, sensitiveMessage),
        } as any,
      );

      await assert.rejects(
        () => service.createRun('user-1', { query: QUERY }),
        (error: unknown) => {
          assert.ok(error instanceof HttpException);
          assert.equal(error.getStatus(), testCase.status);
          assert.equal(
            (error.getResponse() as { message: string }).message,
            testCase.message,
          );
          assert.equal(JSON.stringify(error.getResponse()).includes('secret'), false);
          return true;
        },
      );
    }
  });

  it('rejects unsupported conditions before calling the provider screen operation', async () => {
    let screenCalls = 0;
    const service = new ScreeningService(
      {} as any,
      {
        describeEquityScreener: async () =>
          ok({
            ...DESCRIPTOR,
            metrics: [],
            sortableMetrics: [],
          }),
        screenEquities: async () => {
          screenCalls += 1;
          return ok(snapshot());
        },
      } as any,
    );

    await assert.rejects(
      () => service.createRun('user-1', { query: QUERY }),
      UnprocessableEntityException,
    );
    assert.equal(screenCalls, 0);
  });

  it('freezes provider warnings in the snapshot and restores them with the run', async () => {
    const createCalls: any[] = [];
    const runSnapshot = snapshot();
    const routeConstraints: unknown[] = [];
    let storedRow: any;
    const expectedWarning = {
      code: 'PARTIAL_COVERAGE',
      message: '部分数据未能获取，结果可能不完整。',
      provider: 'cn-screener',
      retryAfterMs: 1_500,
    } as const;
    const service = new ScreeningService(
      {
        screeningRun: {
          create: async (args: any) => {
            createCalls.push(args);
            storedRow = {
              id: 'run-1',
              savedScreenId: null,
              query: args.data.query,
              sourceId: args.data.sourceId,
              capturedAt: args.data.capturedAt,
              snapshot: args.data.snapshot,
              createdAt: new Date('2026-08-22T01:00:00.000Z'),
              savedScreen: null,
              refinements: [],
            };
            return storedRow;
          },
          findFirst: async () => storedRow,
        },
      } as any,
      {
        describeEquityScreener: async (
          _market: string,
          _context: unknown,
          constraints: unknown,
        ) => {
          routeConstraints.push(constraints);
          return ok(DESCRIPTOR);
        },
        screenEquities: async (
          _query: ScreeningQuery,
          _context: unknown,
          constraints: unknown,
        ) => {
          routeConstraints.push(constraints);
          return ok(runSnapshot, 'cn-screener', [{
            ...expectedWarning,
            cause: 'raw provider detail is not persisted',
          }]);
        },
      } as any,
    );

    const result = await service.createRun('user-1', { query: QUERY });
    const restored = await service.getRun('user-1', result.id);

    assert.equal(createCalls.length, 1);
    assert.equal(createCalls[0].data.userId, 'user-1');
    assert.deepEqual(createCalls[0].data.snapshot, {
      ...runSnapshot,
      warnings: [expectedWarning],
    });
    assert.deepEqual(restored.snapshot.warnings, [expectedWarning]);
    assert.deepEqual(routeConstraints, [
      PERSISTABLE_CONSTRAINTS,
      PERSISTABLE_CONSTRAINTS,
    ]);
    assert.equal(result.status, 'COMPLETE');
    assert.equal(result.refinements.length, 0);
    assert.equal(ScreeningRunDtoSchema.safeParse(result).success, true);
  });

  it('deduplicates provider candidates before freezing the snapshot', async () => {
    const duplicateSnapshot = snapshot(['CN:600000', 'CN:600000']);
    const service = new ScreeningService(
      {
        screeningRun: {
          create: async (args: any) => ({
            id: 'run-1',
            savedScreenId: null,
            query: args.data.query,
            sourceId: args.data.sourceId,
            capturedAt: args.data.capturedAt,
            snapshot: args.data.snapshot,
            createdAt: new Date('2026-08-22T01:00:00.000Z'),
            savedScreen: null,
            refinements: [],
          }),
        },
      } as any,
      {
        describeEquityScreener: async () => ok(DESCRIPTOR),
        screenEquities: async () => ok(duplicateSnapshot),
      } as any,
    );

    const result = await service.createRun('user-1', { query: QUERY });

    assert.equal(result.snapshot.items.length, 1);
    assert.equal(result.snapshot.items[0]?.identityKey, 'CN:600000');
  });

  it('rejects provider condition counts that do not match the query', async () => {
    let creates = 0;
    const service = new ScreeningService(
      {
        screeningRun: {
          create: async () => {
            creates += 1;
          },
        },
      } as any,
      {
        describeEquityScreener: async () => ok(DESCRIPTOR),
        screenEquities: async () =>
          ok({ ...snapshot(), conditionCounts: [1, 1] }),
      } as any,
    );

    await assert.rejects(() => service.createRun('user-1', { query: QUERY }));
    assert.equal(creates, 0);
  });

  it('uses an ownership-scoped lookup and hides another user run as 404', async () => {
    const calls: any[] = [];
    const service = new ScreeningService(
      {
        screeningRun: {
          findFirst: async (args: any) => {
            calls.push(args);
            return null;
          },
        },
      } as any,
      {} as any,
    );

    await assert.rejects(
      () => service.getRun('user-1', 'run-other'),
      NotFoundException,
    );
    assert.deepEqual(calls[0].where, { id: 'run-other', userId: 'user-1' });
  });

  it('rejects refinement identities outside the immutable run snapshot', async () => {
    let quoteCalls = 0;
    const { prisma } = refinementPrisma(snapshot());
    const service = new ScreeningService(
      prisma as any,
      {
        getQuote: async () => {
          quoteCalls += 1;
          return failed();
        },
      } as any,
    );

    await assert.rejects(
      () =>
        service.refineRun('user-1', 'run-1', {
          identityKeys: ['CN:600999'],
        }),
      BadRequestException,
    );
    assert.equal(quoteCalls, 0);
  });

  it('refines candidates two at a time and independently upserts each result', async () => {
    const keys = ['CN:600000', 'CN:600001', 'CN:600002'];
    let quoteCallsInFlight = 0;
    let maxQuoteCallsInFlight = 0;
    const upserts: any[] = [];
    const routeCalls: Array<{ operation: string; constraints: unknown }> = [];
    const runSnapshot = snapshot(keys);
    const { prisma, placeholders } = refinementPrisma(runSnapshot, {
      onUpsert: async (args: any) => {
        upserts.push(args);
        return {
          identityKey: args.create.identityKey,
          payload: args.update.payload,
          createdAt: new Date('2026-08-22T02:00:00.000Z'),
          updatedAt: new Date('2026-08-22T02:00:00.000Z'),
        };
      },
    });
    const service = new ScreeningService(
      prisma as any,
      {
        getQuote: async (
          _identityKey: string,
          _context: unknown,
          constraints: unknown,
        ) => {
          routeCalls.push({ operation: 'quote', constraints });
          quoteCallsInFlight += 1;
          maxQuoteCallsInFlight = Math.max(
            maxQuoteCallsInFlight,
            quoteCallsInFlight,
          );
          await new Promise((resolve) => setTimeout(resolve, 10));
          quoteCallsInFlight -= 1;
          return failed();
        },
        getProfile: async (
          _identityKey: string,
          _context: unknown,
          constraints: unknown,
        ) => {
          routeCalls.push({ operation: 'profile', constraints });
          return failed();
        },
        getFinancials: async (
          _identityKey: string,
          _context: unknown,
          constraints: unknown,
        ) => {
          routeCalls.push({ operation: 'financials', constraints });
          return failed();
        },
        getHistory: async (
          _input: unknown,
          _context: unknown,
          constraints: unknown,
        ) => {
          routeCalls.push({ operation: 'history', constraints });
          return failed();
        },
      } as any,
    );

    const result = await service.refineRun('user-1', 'run-1', {
      identityKeys: keys,
    });

    assert.equal(maxQuoteCallsInFlight, 2);
    assert.equal(upserts.length, 3);
    assert.equal(placeholders.length, 3);
    assert.ok(
      placeholders.every(
        (payload) => JSON.stringify(payload) === '{"reservation":true}',
      ),
    );
    assert.deepEqual(
      new Set(routeCalls.map((call) => call.operation)),
      new Set(['quote', 'profile', 'financials', 'history']),
    );
    for (const call of routeCalls) {
      assert.deepEqual(call.constraints, PERSISTABLE_CONSTRAINTS);
    }
    assert.deepEqual(
      result.results.map((item) => item.identityKey),
      keys,
    );
    assert.ok(result.results.every((item) => item.status === 'PARTIAL'));
  });

  it('stores ATR14 as a positive share of the latest close', async () => {
    const bars = Array.from({ length: 16 }, (_, index) => ({
      timestamp: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
      open: 100,
      high: 102,
      low: 98,
      close: 100,
      volume: 1_000,
    }));
    const { prisma } = refinementPrisma(snapshot());
    const service = new ScreeningService(
      prisma as any,
      {
        getQuote: async () => failed(),
        getProfile: async () => failed(),
        getFinancials: async () => failed(),
        getHistory: async () => ok(bars, 'price-history'),
      } as any,
    );

    const result = await service.refineRun('user-1', 'run-1', {
      identityKeys: ['CN:600000'],
    });
    const candidate = result.results[0];

    assert.notEqual(candidate?.status, 'FAILED');
    if (!candidate || candidate.status === 'FAILED') return;
    assert.equal(candidate.refinement.payload.cells.ATR14_PCT?.value, 0.04);
  });

  it('enforces the cumulative 50-candidate refinement limit on the server', async () => {
    let quoteCalls = 0;
    const existing = Array.from(
      { length: 50 },
      (_, index) => `CN:OLD${index}`,
    );
    const { prisma } = refinementPrisma(snapshot(['CN:600000']), { existing });
    const service = new ScreeningService(
      prisma as any,
      {
        getQuote: async () => {
          quoteCalls += 1;
          return failed();
        },
      } as any,
    );

    await assert.rejects(
      () =>
        service.refineRun('user-1', 'run-1', {
          identityKeys: ['CN:600000'],
        }),
      BadRequestException,
    );
    assert.equal(quoteCalls, 0);
  });

  it('atomically reserves the last refinement slot across concurrent requests', async () => {
    const existing = Array.from(
      { length: 49 },
      (_, index) => `CN:OLD${index}`,
    );
    const requested = ['CN:600000', 'CN:600001'];
    const { prisma, rows } = refinementPrisma(
      snapshot([...existing, ...requested]),
      { existing },
    );
    let quoteCalls = 0;
    const service = new ScreeningService(
      prisma as any,
      {
        getQuote: async () => {
          quoteCalls += 1;
          return failed();
        },
        getProfile: async () => failed(),
        getFinancials: async () => failed(),
        getHistory: async () => failed(),
      } as any,
    );

    const settled = await Promise.allSettled(
      requested.map((identityKey) =>
        service.refineRun('user-1', 'run-1', { identityKeys: [identityKey] })),
    );

    assert.equal(
      settled.filter((result) => result.status === 'fulfilled').length,
      1,
    );
    assert.equal(
      settled.filter((result) => result.status === 'rejected').length,
      1,
    );
    const rejected = settled.find((result) => result.status === 'rejected');
    assert.ok(rejected && rejected.reason instanceof BadRequestException);
    assert.equal(rows.size, 50);
    assert.equal(quoteCalls, 1);
  });

  it('keeps unexpected refinement details out of logs and restored results', async () => {
    const sensitiveMessage = 'database host=/internal/db password=secret';
    const { prisma } = refinementPrisma(snapshot(), {
      onUpsert: async () => {
        throw new Error(sensitiveMessage);
      },
    });
    const service = new ScreeningService(
      prisma as any,
      {
        getQuote: async () => failed(),
        getProfile: async () => failed(),
        getFinancials: async () => failed(),
        getHistory: async () => failed(),
      } as any,
    );
    const logs: string[] = [];
    (service as any).logger = {
      error: (message: string) => logs.push(message),
    };

    const result = await service.refineRun('user-1', 'run-1', {
      identityKeys: ['CN:600000'],
    });

    assert.deepEqual(result.results, [{
      identityKey: 'CN:600000',
      status: 'FAILED',
      error: 'Candidate refinement failed.',
    }]);
    assert.equal(logs.length, 1);
    assert.equal(logs[0]?.includes(sensitiveMessage), false);
    assert.equal(JSON.stringify(result).includes(sensitiveMessage), false);
    const restored = await service.getRun('user-1', 'run-1');
    assert.deepEqual(restored.refinements, []);
  });

  it('marks partial upstream data as partial and keeps market-cap provenance aligned', async () => {
    const { prisma } = refinementPrisma(snapshot());
    const quote = ok({
      instrument: { instrumentId: 'CN:600000', market: 'CN', symbol: '600000' },
      price: 10,
      currency: 'CNY',
      timestamp: '2026-08-22T03:00:00.000Z',
    }, 'quote-source');
    const profile = {
      ...partial({
        instrument: { instrumentId: 'CN:600000', market: 'CN', symbol: '600000' },
        marketCap: 9_000_000,
      }, 'profile-source', [{
        code: 'STALE_DATA',
        message: 'Using stale profile data.',
        provider: 'profile-source',
      }]),
      freshness: [{
        provider: 'profile-source',
        asOf: '2025-12-31T00:00:00.000Z',
        retrievedAt: '2026-08-22T03:00:00.000Z',
        stale: true,
      }],
    };
    const financials = ok({
      periods: [],
      currency: 'CNY',
      sourceUrl: 'https://example.com/financials',
      retrievedAt: '2026-08-22T03:00:00.000Z',
      provider: 'financial-source',
      qualityTier: 'B',
    }, 'financial-source');
    const service = new ScreeningService(
      prisma as any,
      {
        getQuote: async () => quote,
        getProfile: async () => profile,
        getFinancials: async () => financials,
        getHistory: async () => ok([], 'history-source'),
      } as any,
    );

    const result = await service.refineRun('user-1', 'run-1', {
      identityKeys: ['CN:600000'],
    });
    const candidate = result.results[0];

    assert.ok(candidate && candidate.status !== 'FAILED');
    assert.equal(candidate.status, 'PARTIAL');
    assert.deepEqual(candidate.refinement.payload.cells.MARKET_CAP, {
      status: 'PRESENT',
      value: 9_000_000,
      unit: 'CURRENCY',
      sourceId: 'profile-source',
      asOf: '2025-12-31T00:00:00.000Z',
      estimated: false,
    });
    assert.deepEqual(candidate.refinement.payload.warnings, [
      'STALE_DATA: 部分数据可能不是最新。',
    ]);
    assert.equal(
      JSON.stringify(candidate).includes('Using stale profile data.'),
      false,
    );
  });

  it('marks market cap as fetch-failed when the selected profile call fails', async () => {
    const { prisma } = refinementPrisma(snapshot());
    const service = new ScreeningService(
      prisma as any,
      {
        getQuote: async () =>
          ok({
            instrument: {
              instrumentId: 'CN:600000',
              market: 'CN',
              symbol: '600000',
            },
            price: 10,
            currency: 'CNY',
            timestamp: '2026-08-22T03:00:00.000Z',
          }, 'quote-source'),
        getProfile: async () => failed('SOURCE_UNAVAILABLE'),
        getFinancials: async () => failed('SOURCE_UNAVAILABLE'),
        getHistory: async () => failed('SOURCE_UNAVAILABLE'),
      } as any,
    );

    const result = await service.refineRun('user-1', 'run-1', {
      identityKeys: ['CN:600000'],
    });
    const candidate = result.results[0];

    assert.ok(candidate && candidate.status !== 'FAILED');
    assert.deepEqual(candidate.refinement.payload.cells.MARKET_CAP, {
      status: 'FETCH_FAILED',
      value: null,
      unit: 'CURRENCY',
      sourceId: 'market-data',
      asOf: null,
      estimated: false,
    });
  });

  it('turns a persistence-policy refusal into a safe refinement warning', async () => {
    const { prisma } = refinementPrisma(snapshot());
    const service = new ScreeningService(
      prisma as any,
      {
        getQuote: async () => failed('PERMISSION_DENIED', 'apikey=secret'),
        getProfile: async () => failed('PERMISSION_DENIED', 'apikey=secret'),
        getFinancials: async () => failed('PERMISSION_DENIED', 'apikey=secret'),
        getHistory: async () => failed('PERMISSION_DENIED', 'apikey=secret'),
      } as any,
    );

    const result = await service.refineRun('user-1', 'run-1', {
      identityKeys: ['CN:600000'],
    });
    const candidate = result.results[0];

    assert.ok(candidate && candidate.status !== 'FAILED');
    assert.deepEqual(candidate.refinement.payload.warnings, [
      'PERMISSION_DENIED: 当前数据源不允许保存该项数据。',
    ]);
    assert.equal(JSON.stringify(candidate).includes('secret'), false);
  });
});
