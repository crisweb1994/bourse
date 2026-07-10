import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BadRequestException } from '@nestjs/common';
import { AnalysisQueryService } from './analysis-query.service';

describe('AnalysisQueryService', () => {
  it('returns history rows without synthetic planner compatibility fields', async () => {
    const rows = [
      {
        id: 'analysis-1',
        userId: 'user-1',
        symbol: 'AAPL',
        status: 'COMPLETED',
        degradedSource: null,
        stock: { symbol: 'AAPL' },
        sections: [{ type: 'FUNDAMENTAL', status: 'COMPLETED' }],
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
    } as never);

    const result = await service.getHistory('user-1', {
      page: 2,
      limit: 10,
      degradedOnly: true,
    });

    assert.equal(result.total, 1);
    assert.equal(result.page, 2);
    assert.equal(result.limit, 10);
    assert.equal(result.items[0], rows[0]);
    assert.equal('snapshotIds' in result.items[0], false);
    assert.equal('research' in result.items[0], false);

    const findArgs = calls[0] as {
      where: Record<string, unknown>;
      skip: number;
      take: number;
    };
    assert.equal(findArgs.where.userId, 'user-1');
    assert.equal(findArgs.where.degradedSource, 'WEB_SEARCH_FALLBACK');
    assert.equal(findArgs.skip, 10);
    assert.equal(findArgs.take, 10);
  });

  it('applies canonical analysis type and status filters', async () => {
    const calls: unknown[] = [];
    const service = new AnalysisQueryService({
      analysis: {
        findMany: async (args: unknown) => {
          calls.push(args);
          return [];
        },
        count: async () => 0,
      },
    } as never);

    await service.getHistory('user-1', {
      analysisType: 'DEBATE',
      status: 'BUDGET_EXHAUSTED',
    });

    const findArgs = calls[0] as { where: Record<string, unknown> };
    assert.equal(findArgs.where.analysisType, 'DEBATE');
    assert.equal(findArgs.where.status, 'BUDGET_EXHAUSTED');
  });

  it('rejects invalid history filters before querying Prisma', async () => {
    const service = new AnalysisQueryService({
      analysis: {
        findMany: async () => {
          throw new Error('should not query');
        },
        count: async () => {
          throw new Error('should not query');
        },
      },
    } as never);

    await assert.rejects(
      () => service.getHistory('user-1', { analysisType: 'NOT_A_TYPE' }),
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
