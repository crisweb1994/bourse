import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { COMPREHENSIVE_DIMENSIONS } from '@bourse/shared-types';
import { AnalysisCommandService } from './analysis-command.service';

function createService() {
  const createCalls: unknown[] = [];
  const service = new AnalysisCommandService(
    {
      stock: {
        findUnique: async () => ({
          id: 'stock-1',
          symbol: 'AAPL',
          market: 'US',
        }),
      },
      analysis: {
        create: async (args: unknown) => {
          createCalls.push(args);
          return { id: 'analysis-1' };
        },
      },
    } as never,
    {
      resolveAnalysisMetadata: async () => ({
        aiModel: 'claude-sonnet-4',
        providerName: 'anthropic',
        settingId: 'setting-1',
      }),
    } as never,
  );

  return { service, createCalls };
}

describe('AnalysisCommandService', () => {
  it('creates one section per comprehensive dimension in canonical order', async () => {
    const { service, createCalls } = createService();

    await service.create('user-1', {
      stockId: 'stock-1',
      analysisType: 'COMPREHENSIVE',
    });

    const createArgs = createCalls[0] as {
      data: {
        analysisType: string;
        sections: { create: Array<{ type: string; order: number }> };
      };
    };
    assert.equal(createArgs.data.analysisType, 'COMPREHENSIVE');
    assert.deepEqual(
      createArgs.data.sections.create.map((section) => section.type),
      COMPREHENSIVE_DIMENSIONS,
    );
    assert.deepEqual(
      createArgs.data.sections.create.map((section) => section.order),
      COMPREHENSIVE_DIMENSIONS.map((_, index) => index),
    );
  });

  it('creates a single matching section for single-dimension analysis', async () => {
    const { service, createCalls } = createService();

    await service.create('user-1', {
      stockId: 'stock-1',
      analysisType: 'VALUATION',
    });

    const createArgs = createCalls[0] as {
      data: {
        analysisType: string;
        sections: { create: Array<{ type: string; order: number }> };
      };
    };
    assert.equal(createArgs.data.analysisType, 'VALUATION');
    assert.deepEqual(createArgs.data.sections.create, [
      { type: 'VALUATION', order: 0 },
    ]);
  });

  it('rejects legacy analysis types even if controller validation is bypassed', async () => {
    const { service, createCalls } = createService();

    await assert.rejects(
      () =>
        service.create('user-1', {
          stockId: 'stock-1',
          analysisType: 'DEBATE',
        } as never),
      /has no section type/,
    );
    assert.equal(createCalls.length, 0);
  });
});
