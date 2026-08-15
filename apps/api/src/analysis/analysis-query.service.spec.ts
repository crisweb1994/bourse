import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BadRequestException } from '@nestjs/common';
import { AnalysisQueryService } from './analysis-query.service';

describe('AnalysisQueryService', () => {
  it('returns V2 history rows and maps Prisma focus-window names', async () => {
    const rows = [
      {
        id: 'analysis-1',
        userId: 'user-1',
        symbol: 'AAPL',
        mode: 'QUICK',
        focusWindow: 'D90',
        status: 'PARTIAL_FAILED',
        stock: { symbol: 'AAPL' },
        sections: [
          { type: 'COMPANY_QUALITY', status: 'COMPLETED' },
          { type: 'RISK_REGISTER', status: 'FAILED' },
        ],
      },
    ];
    const calls: unknown[] = [];
    const service = new AnalysisQueryService({
      analysis: {
        findMany: async (args: unknown) => {
          calls.push(args);
          return rows;
        },
        count: async () => rows.length,
      },
    } as any);

    const result = await service.getHistory('user-1', {
      page: 2,
      limit: 10,
      mode: 'QUICK',
      status: 'PARTIAL_FAILED',
      symbol: 'app',
      stockId: 'stock-1',
    });

    assert.equal(result.total, 1);
    assert.equal(result.page, 2);
    assert.equal(result.limit, 10);
    assert.equal(result.items[0]!.focusWindow, '90D');
    assert.equal(result.items[0]!.sections[0]!.type, 'COMPANY_QUALITY');
    assert.equal(result.items[0]!.sections[1]!.status, 'FAILED');

    const findArgs = calls[0] as {
      where: Record<string, any>;
      skip: number;
      take: number;
    };
    assert.deepEqual(findArgs.where, {
      userId: 'user-1',
      mode: 'QUICK',
      status: 'PARTIAL_FAILED',
      symbol: { contains: 'app', mode: 'insensitive' },
      stockId: 'stock-1',
    });
    assert.equal(findArgs.skip, 10);
    assert.equal(findArgs.take, 10);
  });

  it('accepts all V2 modes and terminal statuses as filters', async () => {
    const calls: unknown[] = [];
    const service = new AnalysisQueryService({
      analysis: {
        findMany: async (args: unknown) => {
          calls.push(args);
          return [];
        },
        count: async () => 0,
      },
    } as any);

    await service.getHistory('user-1', {
      mode: 'DEEP',
      status: 'CANCELLED',
    });

    const where = (calls[0] as any).where;
    assert.equal(where.mode, 'DEEP');
    assert.equal(where.status, 'CANCELLED');
  });

  it('rejects invalid V2 history filters before querying Prisma', async () => {
    const service = new AnalysisQueryService({
      analysis: {
        findMany: async () => {
          throw new Error('should not query');
        },
        count: async () => {
          throw new Error('should not query');
        },
      },
    } as any);

    await assert.rejects(
      () => service.getHistory('user-1', { mode: 'NOT_A_MODE' }),
      BadRequestException,
    );
    await assert.rejects(
      () => service.getHistory('user-1', { status: 'NOT_A_STATUS' }),
      BadRequestException,
    );
    await assert.rejects(
      () => service.getHistory('user-1', { page: Number.NaN }),
      BadRequestException,
    );
    await assert.rejects(
      () => service.getHistory('user-1', { limit: 101 }),
      BadRequestException,
    );
  });
});
