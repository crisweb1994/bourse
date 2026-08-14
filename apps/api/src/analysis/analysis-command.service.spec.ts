import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SECTION_ORDER } from '@bourse/shared-types';
import { Prisma } from '@prisma/client';
import { ConflictException } from '@nestjs/common';
import { AnalysisCommandService } from './analysis-command.service';

type CreateCall = {
  data: {
    userId: string;
    stockId: string;
    symbol: string;
    market: string;
    mode: string;
    focusWindow: string;
    question: string | null;
    aiProvider: string;
    aiModel: string;
    aiProviderSettingId: string | null;
    sections: { create: Array<{ type: string; order: number }> };
  };
};

function createService(options: {
  ongoing?: { id: string } | null;
  stock?: { id: string; symbol: string; market: string } | null;
} = {}) {
  const createCalls: CreateCall[] = [];
  const analysisUpdates: unknown[] = [];
  const sectionUpdates: unknown[] = [];
  const stock = options.stock === undefined
    ? { id: 'stock-1', symbol: 'AAPL', market: 'US' }
    : options.stock;

  const prisma = {
    stock: {
      findUnique: async () => stock,
    },
    analysis: {
      findFirst: async () => options.ongoing ?? null,
      create: async (args: CreateCall) => {
        createCalls.push(args);
        return {
          id: 'analysis-1',
          mode: args.data.mode,
          focusWindow: args.data.focusWindow,
          sections: args.data.sections.create,
        };
      },
      update: async (args: unknown) => {
        analysisUpdates.push(args);
        return { id: 'analysis-1' };
      },
    },
  } as any;

  const providerResolver = {
    resolveAnalysisMetadata: async () => ({
      aiModel: 'claude-sonnet-4',
      providerName: 'anthropic',
      settingId: 'setting-1',
    }),
  } as any;

  const runRegistry = {
    abort: () => false,
    isRunning: () => false,
  } as any;

  return {
    service: new AnalysisCommandService(prisma, providerResolver, runRegistry),
    createCalls,
    analysisUpdates,
    sectionUpdates,
    prisma,
  };
}

describe('AnalysisCommandService', () => {
  it('creates the five V2 sections in canonical order and stores mode/window', async () => {
    const { service, createCalls } = createService();

    await service.create('user-1', {
      stockId: 'stock-1',
      mode: 'DEEP',
      focusWindow: '1Y',
      question: '  毛利率下滑是短期波动吗？  ',
    });

    const data = createCalls[0]!.data;
    assert.equal(data.userId, 'user-1');
    assert.equal(data.stockId, 'stock-1');
    assert.equal(data.mode, 'DEEP');
    // Prisma stores the public 1Y value under its enum name Y1.
    assert.equal(data.focusWindow, 'Y1');
    assert.equal(data.question, '毛利率下滑是短期波动吗？');
    assert.equal(data.aiProvider, 'anthropic');
    assert.equal(data.aiModel, 'claude-sonnet-4');
    assert.equal(data.aiProviderSettingId, 'setting-1');
    assert.deepEqual(
      data.sections.create.map((section) => section.type),
      SECTION_ORDER,
    );
    assert.deepEqual(
      data.sections.create.map((section) => section.order),
      SECTION_ORDER.map((_, index) => index),
    );
  });

  it('defaults the focus window to 90D and normalizes an empty question', async () => {
    const { service, createCalls } = createService();

    await service.create('user-1', {
      stockId: 'stock-1',
      mode: 'QUICK',
      question: '   ',
    });

    assert.equal(createCalls[0]!.data.mode, 'QUICK');
    assert.equal(createCalls[0]!.data.focusWindow, 'D90');
    assert.equal(createCalls[0]!.data.question, null);
  });

  it('rejects a second running analysis for the same user and stock', async () => {
    const { service, createCalls } = createService({ ongoing: { id: 'analysis-old' } });

    await assert.rejects(
      () => service.create('user-1', { stockId: 'stock-1', mode: 'QUICK' }),
      ConflictException,
    );
    assert.equal(createCalls.length, 0);
  });

  it('resets failed sections and dependent risk before retrying with the same snapshot', async () => {
    const sectionCalls: unknown[] = [];
    const analysisCalls: unknown[] = [];
    let transactionCalls = 0;
    const service = new AnalysisCommandService(
      {
        analysis: {
          findFirst: async () => ({
            id: 'analysis-1',
            status: 'PARTIAL_FAILED',
            mode: 'DEEP',
            focusWindow: 'D90',
            sections: [
              { type: 'COMPANY_QUALITY', status: 'FAILED' },
              { type: 'INDUSTRY_POSITION', status: 'COMPLETED' },
              { type: 'VALUATION_SCENARIOS', status: 'SKIPPED' },
              { type: 'RISK_REGISTER', status: 'COMPLETED' },
              { type: 'MARKET_SIGNALS', status: 'COMPLETED' },
            ],
            evidenceSnapshot: { id: 'snapshot-1' },
          }),
          update: async (args: unknown) => {
            analysisCalls.push(args);
            return { id: 'analysis-1' };
          },
        },
      } as any,
      {} as any,
      {} as any,
    );

    const prisma = (service as any).prisma;
    prisma.$transaction = async (callback: (tx: any) => Promise<void>) => {
      transactionCalls += 1;
      await callback({
        analysisSection: {
          updateMany: async (args: unknown) => {
            sectionCalls.push(args);
            return { count: 1 };
          },
        },
        analysis: {
          update: async (args: unknown) => {
            analysisCalls.push(args);
            return { id: 'analysis-1' };
          },
        },
      });
    };

    await service.retry('user-1', 'analysis-1');

    assert.equal(transactionCalls, 1);
    assert.equal(sectionCalls.length, 2);
    assert.deepEqual((sectionCalls[0] as any).where.status.in, ['FAILED', 'SKIPPED']);
    assert.deepEqual((sectionCalls[1] as any).where.type, 'RISK_REGISTER');
    assert.equal((sectionCalls[0] as any).data.status, 'PENDING');
    assert.equal((sectionCalls[1] as any).data.status, 'PENDING');
    assert.equal(analysisCalls.length, 1);
    const analysisCall = analysisCalls[0] as any;
    assert.deepEqual(analysisCall, {
      where: { id: 'analysis-1' },
      data: {
        status: 'PENDING',
        summaryMarkdown: null,
        summaryJson: Prisma.JsonNull,
        overallSignal: null,
        overallConfidence: null,
        errorCode: null,
        errorMessage: null,
        startedAt: null,
        completedAt: null,
      },
    });
  });

  it('refuses retry when the evidence snapshot is missing', async () => {
    const service = new AnalysisCommandService(
      {
        analysis: {
          findFirst: async () => ({
            id: 'analysis-1',
            status: 'FAILED',
            sections: [],
            evidenceSnapshot: null,
          }),
        },
      } as any,
      {} as any,
      {} as any,
    );

    await assert.rejects(
      () => service.retry('user-1', 'analysis-1'),
      /no evidence snapshot/,
    );
  });
});
