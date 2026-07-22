import test from 'node:test';
import assert from 'node:assert/strict';
import { Prisma } from '@prisma/client';
import {
  EarningsBudgetService,
  estimateStructuredOutputReservationUsd,
} from './earnings-budget.service';

test('budget reservation accounts for a possible repair call', () => {
  const reserved = estimateStructuredOutputReservationUsd(
    'claude-haiku-4-5',
    'system',
    '正文'.repeat(1_000),
    4_000,
  );
  assert.ok(reserved > 0.04, `expected conservative reservation, got ${reserved}`);
});

test('budget reserve rejects before mutating a run when committed spend is too high', async () => {
  let updated = false;
  let aggregateWhere: any;
  const tx = {
    $executeRaw: async () => 1,
    earningsGenerationRun: {
      updateMany: async (args: any) => {
        if (args.where?.id) updated = true;
        return { count: 0 };
      },
      aggregate: async (args: any) => {
        aggregateWhere = args.where;
        return {
          _sum: {
            costUsd: new Prisma.Decimal('0.99'),
            budgetReservedUsd: new Prisma.Decimal('0'),
          },
        };
      },
    },
  };
  const prisma = { $transaction: async (fn: any) => fn(tx) };
  const config = { get: (key: string) => key === 'EARNINGS_DAILY_BUDGET_USD' ? '1' : undefined };
  const service = new EarningsBudgetService(prisma as any, config as any);

  const result = await service.reserve('run-1', 'claude-haiku-4-5', 'system', 'prompt', 4_000);

  assert.deepEqual(result, { available: false, code: 'BUDGET_EXHAUSTED' });
  assert.equal(updated, false);
  assert.ok(aggregateWhere.startedAt.gte instanceof Date);
  assert.equal(aggregateWhere.createdAt, undefined);
});

test('budget settlement atomically replaces a reservation with actual spend', async () => {
  let data: any;
  const tx = {
    $executeRaw: async () => 1,
    earningsGenerationRun: {
      update: async (args: any) => {
        data = args.data;
        return args.data;
      },
    },
  };
  const service = new EarningsBudgetService(
    { $transaction: async (fn: any) => fn(tx) } as any,
    { get: () => undefined } as any,
  );

  await service.settle('run-1', 0.03125);

  assert.equal(data.costUsd.toString(), '0.03125');
  assert.equal(data.budgetReservedUsd.toString(), '0');
});
