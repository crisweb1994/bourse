import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type {
  AgentProvider,
  ComprehensiveOptions,
  DimensionInput,
  SseEvent,
} from '@bourse/analysis';
import {
  runAnalysisWorkflowAdapter,
  type AdapterContext,
} from './analysis-workflow-adapter';

// Exercises the workflow adapter by injecting scripted domain events and
// asserting the API SSE frames plus Prisma writes.

const RUN_ID = 'analysis-test-1';
const TODAY = '2026-05-15T00:00:00.000Z';
const URL = 'https://cninfo.com.cn/x';

// ===== Stub builders =====

function evt<T extends SseEvent['type']>(
  type: T,
  rest: Record<string, unknown>,
  seq = 0,
): SseEvent {
  return { type, runId: RUN_ID, seq, ...rest } as unknown as SseEvent;
}

interface PrismaCall {
  table: 'analysisSection' | 'analysis';
  method: 'update' | 'updateMany';
  args: unknown;
}

interface SendCall {
  type: string;
  data: Record<string, unknown>;
}

function buildCtx(opts: {
  events: SseEvent[];
  finalReturn?: unknown;
  finalThrow?: Error;
  sections?: Array<{ id: string; type: string; order: number; status: string }>;
  market?: string;
  mode?: 'comprehensive' | 'single';
  analysisType?: string;
}): {
  ctx: AdapterContext;
  prismaCalls: PrismaCall[];
  sendCalls: SendCall[];
} {
  const prismaCalls: PrismaCall[] = [];
  const sendCalls: SendCall[] = [];

  const makeGen = (): AsyncGenerator<SseEvent, unknown, undefined> =>
    (async function* () {
      for (const e of opts.events) {
        yield e;
      }
      if (opts.finalThrow) throw opts.finalThrow;
      return opts.finalReturn ?? undefined;
    })();

  const fakeFactory = (
    _provider: AgentProvider,
    _input: DimensionInput,
    _options: ComprehensiveOptions,
  ): AsyncGenerator<SseEvent, unknown, undefined> => makeGen();

  const fakeSingleFactory = (
    _provider: AgentProvider,
    _input: DimensionInput,
  ): AsyncGenerator<SseEvent, unknown, undefined> => makeGen();

  const sections =
    opts.sections ??
    [
      { id: 'sec-1', type: 'FUNDAMENTAL', order: 0, status: 'PENDING' },
      { id: 'sec-2', type: 'VALUATION', order: 1, status: 'PENDING' },
    ];

  const ctx: AdapterContext = {
    analysisId: 'a1',
    analysis: {
      id: 'a1',
      analysisType: opts.analysisType ?? 'COMPREHENSIVE',
      sections,
      stock: {
        symbol: 'AAPL',
        market: opts.market ?? 'CN',
        name: 'Apple',
      },
    },
    provider: {
      name: 'fake',
      stream: () => Promise.reject(new Error('not used')),
      complete: () => Promise.reject(new Error('not used')),
      getModel: () => 'm',
      getUtilityModel: () => 'jm',
    } as unknown as AgentProvider,
    send: ((type: string, data: unknown) => {
      sendCalls.push({
        type,
        data: data as Record<string, unknown>,
      });
    }) as AdapterContext['send'],
    prisma: {
      analysisSection: {
        update: async (args: unknown) => {
          prismaCalls.push({
            table: 'analysisSection',
            method: 'update',
            args,
          });
          return {};
        },
        updateMany: async (args: unknown) => {
          prismaCalls.push({
            table: 'analysisSection',
            method: 'updateMany',
            args,
          });
          return { count: 1 };
        },
      },
      analysis: {
        update: async (args: unknown) => {
          prismaCalls.push({ table: 'analysis', method: 'update', args });
          return {};
        },
      },
    } as unknown as AdapterContext['prisma'],
    toolCache: {} as AdapterContext['toolCache'],
    modelId: 'claude-sonnet-4-test',
    _streamFactory: fakeFactory,
    _singleStreamFactory: fakeSingleFactory,
    ...(opts.mode ? { mode: opts.mode } : {}),
  };

  return { ctx, prismaCalls, sendCalls };
}

// ===== Tests =====

describe('runAnalysisWorkflowAdapter — happy path', () => {
  it('translates a full section event chain into apps/api SSE + persists rows', async () => {
    const events: SseEvent[] = [
      evt('section_start', { sectionType: 'FUNDAMENTAL', order: 0 }, 1),
      evt(
        'report_chunk',
        { sectionType: 'FUNDAMENTAL', deltaText: 'hello ' },
        2,
      ),
      evt(
        'report_chunk',
        { sectionType: 'FUNDAMENTAL', deltaText: 'world' },
        3,
      ),
      evt(
        'citation',
        {
          sectionType: 'FUNDAMENTAL',
          citation: {
            title: 'S',
            url: URL,
            sourceType: 'NEWS',
            retrievedAt: TODAY,
          },
        },
        4,
      ),
      evt(
        'report_complete',
        { sectionType: 'FUNDAMENTAL', fullMarkdown: 'hello world' },
        5,
      ),
      evt(
        'structured_data',
        {
          sectionType: 'FUNDAMENTAL',
          json: { conclusion: { signal: 'BULLISH', confidence: 'HIGH' } },
        },
        6,
      ),
      evt(
        'section_complete',
        {
          sectionType: 'FUNDAMENTAL',
          status: 'COMPLETED',
          usage: {
            tokensIn: 100,
            tokensOut: 50,
            llmCalls: 1,
            toolCalls: 2,
            durationMs: 1234,
            citationsCount: 1,
            costUsd: 0.01,
          },
        },
        7,
      ),
      evt('done', { status: 'COMPLETED' } as never, 8),
    ];

    const { ctx, prismaCalls, sendCalls } = buildCtx({
      events,
      sections: [
        { id: 'sec-1', type: 'FUNDAMENTAL', order: 0, status: 'PENDING' },
      ],
    });

    const result = await runAnalysisWorkflowAdapter(ctx);

    assert.equal(result.terminalStatus, 'COMPLETED');
    assert.equal(result.failedSectionTypes.length, 0);

    // SSE: every agent event mapped to a client event
    const sendTypes = sendCalls.map((c) => c.type);
    assert.deepEqual(sendTypes, [
      'section_start',
      'report_chunk',
      'report_chunk',
      'citation',
      'report_complete',
      'structured_data',
      'section_complete',
      'done',
    ]);

    // Section row written with accumulated markdown + structured + citations
    const sectionUpdate = prismaCalls.find(
      (c) => c.table === 'analysisSection' && c.method === 'update',
    );
    assert.ok(sectionUpdate, 'expected analysisSection.update');
    const updateArgs = sectionUpdate!.args as {
      where: { id: string };
      data: Record<string, unknown>;
    };
    assert.equal(updateArgs.where.id, 'sec-1');
    assert.equal(updateArgs.data.status, 'COMPLETED');
    assert.equal(updateArgs.data.reportMarkdown, 'hello world');
    assert.equal(updateArgs.data.tokensIn, 100);
    assert.equal(updateArgs.data.tokensOut, 50);
    assert.equal(updateArgs.data.durationMs, 1234);
    assert.equal(updateArgs.data.signal, 'BULLISH');
    assert.equal(updateArgs.data.confidence, 'HIGH');

    // Analysis row written on done
    const analysisUpdate = prismaCalls.find((c) => c.table === 'analysis');
    assert.ok(analysisUpdate, 'expected analysis.update');
    const aArgs = analysisUpdate!.args as { data: { status: string } };
    assert.equal(aArgs.data.status, 'COMPLETED');
  });

  it('forwards summary_chunk and summary_complete; writes summary fields to Analysis', async () => {
    const events: SseEvent[] = [
      evt(
        'summary_chunk',
        { deltaText: 'overall ' } as never,
        1,
      ),
      evt(
        'summary_chunk',
        { deltaText: 'bullish' } as never,
        2,
      ),
      evt(
        'summary_complete',
        {
          fullMarkdown: 'overall bullish',
          json: {
            overallSignal: 'BULLISH',
            overallConfidence: 'HIGH',
            dataAsOf: '2026-05-15',
          },
        } as never,
        3,
      ),
      evt('done', { status: 'COMPLETED' } as never, 4),
    ];

    const { ctx, prismaCalls, sendCalls } = buildCtx({ events });

    await runAnalysisWorkflowAdapter(ctx);

    // Two summary_chunk events + the synthetic `report_complete{COMPREHENSIVE}`
    // + summary_complete + done
    const sendTypes = sendCalls.map((c) => c.type);
    assert.deepEqual(sendTypes, [
      'summary_chunk',
      'summary_chunk',
      'report_complete',
      'summary_complete',
      'done',
    ]);

    const reportCompleteCall = sendCalls.find(
      (c) => c.type === 'report_complete',
    );
    assert.equal(reportCompleteCall!.data.sectionType, 'COMPREHENSIVE');

    const summaryComplete = sendCalls.find(
      (c) => c.type === 'summary_complete',
    );
    assert.deepEqual(summaryComplete!.data, {
      summaryJson: {
        overallSignal: 'BULLISH',
        overallConfidence: 'HIGH',
        dataAsOf: '2026-05-15',
      },
    });

    const analysisUpdate = prismaCalls.find((c) => c.table === 'analysis');
    const aData = (analysisUpdate!.args as { data: Record<string, unknown> })
      .data;
    assert.equal(aData.summaryMarkdown, 'overall bullish');
    assert.equal(aData.overallSignal, 'BULLISH');
    assert.equal(aData.overallConfidence, 'HIGH');
    assert.equal(aData.dataAsOf, '2026-05-15');
  });
});

describe('runAnalysisWorkflowAdapter — partial / fail / cancel', () => {
  it('PARTIAL_FAILED: failed section listed in failedSectionTypes', async () => {
    const events: SseEvent[] = [
      evt('section_start', { sectionType: 'FUNDAMENTAL', order: 0 }, 1),
      evt(
        'section_complete',
        { sectionType: 'FUNDAMENTAL', status: 'FAILED' },
        2,
      ),
      evt('done', { status: 'PARTIAL_FAILED' } as never, 3),
    ];

    const { ctx } = buildCtx({
      events,
      sections: [
        { id: 'sec-1', type: 'FUNDAMENTAL', order: 0, status: 'PENDING' },
      ],
    });

    const result = await runAnalysisWorkflowAdapter(ctx);
    assert.equal(result.terminalStatus, 'PARTIAL_FAILED');
    assert.deepEqual(result.failedSectionTypes, ['FUNDAMENTAL']);
  });

  it('FAILED: factory throws → terminal status FAILED, error + done emitted', async () => {
    const { ctx, sendCalls } = buildCtx({
      events: [],
      finalThrow: new Error('boom'),
    });

    const result = await runAnalysisWorkflowAdapter(ctx);
    assert.equal(result.terminalStatus, 'FAILED');

    const errSend = sendCalls.find((c) => c.type === 'error');
    assert.ok(errSend, 'expected error SSE');
    assert.equal(errSend!.data.message, 'boom');

    const doneSend = sendCalls.find((c) => c.type === 'done');
    assert.ok(doneSend, 'expected done SSE');
    assert.equal(doneSend!.data.status, 'FAILED');
  });

  it('marks unfinished sections as FAILED after a mid-stream throw', async () => {
    // 3 sections seeded. 1 completes normally, 1 starts but never completes,
    // 1 never starts. Then factory throws (mimics an upstream failure
    // mid-stream).
    const events: SseEvent[] = [
      evt('section_start', { sectionType: 'FUNDAMENTAL', order: 0 }, 1),
      evt(
        'section_complete',
        { sectionType: 'FUNDAMENTAL', status: 'COMPLETED' },
        2,
      ),
      evt('section_start', { sectionType: 'VALUATION', order: 1 }, 3),
      // VALUATION never gets section_complete; INDUSTRY never even starts.
    ];

    const { ctx, prismaCalls } = buildCtx({
      events,
      finalThrow: new Error('boom'),
      sections: [
        { id: 'sec-1', type: 'FUNDAMENTAL', order: 0, status: 'PENDING' },
        { id: 'sec-2', type: 'VALUATION', order: 1, status: 'PENDING' },
        { id: 'sec-3', type: 'INDUSTRY', order: 2, status: 'PENDING' },
      ],
    });

    const result = await runAnalysisWorkflowAdapter(ctx);
    assert.equal(result.terminalStatus, 'FAILED');

    // The orphan sweep should run a single updateMany on the two stragglers.
    const orphanSweep = prismaCalls.find(
      (c) =>
        c.table === 'analysisSection' &&
        c.method === 'updateMany' &&
        (c.args as { data?: { status?: string } }).data?.status === 'FAILED',
    );
    assert.ok(orphanSweep, 'expected orphan-section updateMany with FAILED');
    const sweepArgs = orphanSweep!.args as {
      where: { type: { in: string[] } };
      data: { status: string; errorMessage: string };
    };
    assert.deepEqual(new Set(sweepArgs.where.type.in), new Set(['VALUATION', 'INDUSTRY']));
    assert.equal(sweepArgs.data.status, 'FAILED');
    assert.match(sweepArgs.data.errorMessage, /failed/i);

    // failedSectionTypes must include both stragglers (not the completed one).
    assert.deepEqual(
      new Set(result.failedSectionTypes),
      new Set(['VALUATION', 'INDUSTRY']),
    );
  });

  it('persists section-scoped error messages without sweep overwrite', async () => {
    // Mimics what comprehensive.ts emits when streamDimension throws
    // mid-wave: a top-level `error` event with sectionType + message,
    // followed by the workflow moving on (no section_complete for that
    // dim). Adapter must capture the real message into the DB row.
    const events: SseEvent[] = [
      evt('section_start', { sectionType: 'FUNDAMENTAL', order: 0 }, 1),
      evt(
        'error',
        {
          sectionType: 'FUNDAMENTAL',
          message: '404 status code (no body)',
          recoverable: false,
        } as never,
        2,
      ),
      evt('done', { status: 'PARTIAL_FAILED' } as never, 3),
    ];

    const { ctx, prismaCalls } = buildCtx({
      events,
      sections: [
        { id: 'sec-fund', type: 'FUNDAMENTAL', order: 0, status: 'PENDING' },
      ],
    });

    const result = await runAnalysisWorkflowAdapter(ctx);
    assert.equal(result.terminalStatus, 'PARTIAL_FAILED');

    // The error-event handler should have called prisma.analysisSection.update
    // with status=FAILED + the real message (NOT the sweep fallback text).
    const updates = prismaCalls.filter(
      (c) =>
        c.table === 'analysisSection' &&
        c.method === 'update' &&
        (c.args as { data?: { status?: string } }).data?.status === 'FAILED',
    );
    assert.ok(updates.length >= 1, 'expected analysisSection.update with FAILED');
    const data = (updates[0]!.args as { data: { errorMessage: string } }).data;
    assert.equal(data.errorMessage, '404 status code (no body)');
    // Sweep must NOT have run for this section (already in failedSectionTypes).
    const sweepRuns = prismaCalls.filter(
      (c) =>
        c.table === 'analysisSection' &&
        c.method === 'updateMany' &&
        (c.args as { data?: { errorMessage?: string } }).data?.errorMessage
          ?.includes('Run failed before this section completed'),
    );
    assert.equal(sweepRuns.length, 0, 'sweep should NOT overwrite real error');
  });

  it('marks an in-progress orphan section as FAILED', async () => {
    const events: SseEvent[] = [
      evt('section_start', { sectionType: 'FUNDAMENTAL', order: 0 }, 1),
      // Never reaches section_complete — generator throws.
    ];

    const { ctx, prismaCalls } = buildCtx({
      events,
      finalThrow: new Error('boom'),
      sections: [
        { id: 'sec-1', type: 'FUNDAMENTAL', order: 0, status: 'PENDING' },
      ],
    });

    const result = await runAnalysisWorkflowAdapter(ctx);
    assert.equal(result.terminalStatus, 'FAILED');

    const orphanSweep = prismaCalls.find(
      (c) =>
        c.table === 'analysisSection' &&
        c.method === 'updateMany' &&
        (c.args as { data?: { status?: string } }).data?.status === 'FAILED',
    );
    assert.ok(orphanSweep, 'expected orphan updateMany with FAILED');

    // Zero sections actually finished; the only seeded section is the orphan.
    assert.deepEqual(result.failedSectionTypes, ['FUNDAMENTAL']);
  });
});

describe('runAnalysisWorkflowAdapter — non-CN market', () => {
  it('omits marketProfile for non-CN runs but still drives streaming', async () => {
    const events: SseEvent[] = [evt('done', { status: 'COMPLETED' } as never, 1)];
    const factoryOptions: ComprehensiveOptions[] = [];
    const fakeFactory = (
      _p: AgentProvider,
      _i: DimensionInput,
      o: ComprehensiveOptions,
    ): AsyncGenerator<SseEvent, unknown, undefined> => {
      factoryOptions.push(o);
      return (async function* () {
        for (const e of events) yield e;
      })();
    };

    const { ctx } = buildCtx({ events, market: 'US' });
    ctx._streamFactory = fakeFactory;

    await runAnalysisWorkflowAdapter(ctx);

    assert.equal(factoryOptions.length, 1);
    assert.equal(factoryOptions[0]!.marketProfile, undefined);
    assert.equal(factoryOptions[0]!.waveMode, 'auto');
  });
});

describe('runAnalysisWorkflowAdapter — selective judge', () => {
  it('forwards judge_start/judge_complete + writes judgeResult to section', async () => {
    const judgeResult = {
      schemaVersion: 'judge-result-v1' as const,
      pass: false,
      concerns: ['PE 30x unsupported by peerPE p50'],
      suggestedRevisions: ['revise to MEDIUM'],
      confidenceAdjustment: 'DOWNGRADE_TO_MEDIUM' as const,
    };
    const events: SseEvent[] = [
      evt('section_start', { sectionType: 'VALUATION', order: 0 }, 1),
      evt(
        'structured_data',
        {
          sectionType: 'VALUATION',
          json: {
            conclusion: { signal: 'BULLISH', confidence: 'HIGH' },
            evidence: [],
          },
        },
        2,
      ),
      evt(
        'section_complete',
        {
          sectionType: 'VALUATION',
          status: 'COMPLETED',
          usage: {
            tokensIn: 200,
            tokensOut: 100,
            llmCalls: 1,
            toolCalls: 0,
            durationMs: 1000,
            citationsCount: 0,
            costUsd: 0.02,
          },
        },
        3,
      ),
      evt('judge_start', { sectionType: 'VALUATION' }, 4),
      evt(
        'judge_complete',
        {
          sectionType: 'VALUATION',
          result: judgeResult,
          traceTokensIn: 150,
          traceTokensOut: 40,
          traceCostUsd: 0.005,
          traceDurationMs: 80,
        },
        5,
      ),
      evt('done', { status: 'COMPLETED' } as never, 6),
    ];

    const { ctx, prismaCalls, sendCalls } = buildCtx({
      events,
      sections: [{ id: 'sec-val', type: 'VALUATION', order: 0, status: 'PENDING' }],
    });
    const result = await runAnalysisWorkflowAdapter(ctx);

    assert.equal(result.terminalStatus, 'COMPLETED');

    // SSE forwarded verbatim
    const judgeStartCalls = sendCalls.filter((c) => c.type === 'judge_start');
    const judgeCompleteCalls = sendCalls.filter((c) => c.type === 'judge_complete');
    assert.equal(judgeStartCalls.length, 1);
    assert.equal(judgeCompleteCalls.length, 1);
    const jc = judgeCompleteCalls[0]!.data as Record<string, unknown>;
    assert.equal(jc.sectionType, 'VALUATION');
    assert.equal(jc.traceCostUsd, 0.005);
    assert.equal((jc.result as { pass: boolean }).pass, false);

    // structuredJson updated with judgeResult sub-field + downgraded confidence
    const sectionUpdates = prismaCalls.filter(
      (c) => c.table === 'analysisSection' && c.method === 'updateMany',
    );
    assert.ok(sectionUpdates.length >= 1, 'expected an analysisSection.updateMany on judge_complete');
    const lastUpdate = sectionUpdates[sectionUpdates.length - 1]!.args as {
      data: { structuredJson: Record<string, unknown> };
    };
    const persisted = lastUpdate.data.structuredJson;
    assert.deepEqual(persisted.judgeResult, judgeResult);
    const conclusion = persisted.conclusion as { confidence: string };
    assert.equal(conclusion.confidence, 'MEDIUM');
  });

  it('KEEP adjustment leaves section confidence unchanged', async () => {
    const judgeResult = {
      schemaVersion: 'judge-result-v1' as const,
      pass: true,
      concerns: [],
      suggestedRevisions: [],
      confidenceAdjustment: 'KEEP' as const,
    };
    const events: SseEvent[] = [
      evt('section_start', { sectionType: 'RISK', order: 0 }, 1),
      evt(
        'structured_data',
        {
          sectionType: 'RISK',
          json: {
            conclusion: { signal: 'BEARISH', confidence: 'HIGH' },
            evidence: [],
          },
        },
        2,
      ),
      evt(
        'section_complete',
        {
          sectionType: 'RISK',
          status: 'COMPLETED',
          usage: {
            tokensIn: 100,
            tokensOut: 50,
            llmCalls: 1,
            toolCalls: 0,
            durationMs: 500,
            citationsCount: 0,
            costUsd: 0.01,
          },
        },
        3,
      ),
      evt('judge_start', { sectionType: 'RISK' }, 4),
      evt(
        'judge_complete',
        {
          sectionType: 'RISK',
          result: judgeResult,
          traceTokensIn: 100,
          traceTokensOut: 30,
          traceCostUsd: 0.003,
          traceDurationMs: 50,
        },
        5,
      ),
      evt('done', { status: 'COMPLETED' } as never, 6),
    ];

    const { ctx, prismaCalls } = buildCtx({
      events,
      sections: [{ id: 'sec-risk', type: 'RISK', order: 0, status: 'PENDING' }],
    });
    await runAnalysisWorkflowAdapter(ctx);

    // The adapter calls updateMany twice for a CN run: once at start to flip
    // all sections to IN_PROGRESS, then once per judge_complete carrying
    // structuredJson. We want the latter, so filter for entries that have
    // a structuredJson payload and take the last.
    const judgeUpdates = prismaCalls.filter(
      (c) =>
        c.table === 'analysisSection' &&
        c.method === 'updateMany' &&
        (c.args as { data?: { structuredJson?: unknown } }).data
          ?.structuredJson !== undefined,
    );
    assert.ok(judgeUpdates.length >= 1, 'expected a structuredJson updateMany on judge_complete');
    const updateMany = judgeUpdates[judgeUpdates.length - 1]!.args as {
      data: { structuredJson: Record<string, unknown> };
    };
    const conclusion = updateMany.data.structuredJson.conclusion as {
      confidence: string;
    };
    // KEEP must not move confidence away from HIGH.
    assert.equal(conclusion.confidence, 'HIGH');
    assert.deepEqual(updateMany.data.structuredJson.judgeResult, judgeResult);
  });
});

describe('runAnalysisWorkflowAdapter — single dimension mode', () => {
  it('drives streamSingle, persists the section, finalizes overall* from done.result (no summary fields)', async () => {
    const events: SseEvent[] = [
      evt('section_start', { sectionType: 'VALUATION', order: 0 }, 1),
      evt('report_chunk', { sectionType: 'VALUATION', deltaText: 'val' }, 2),
      evt(
        'structured_data',
        {
          sectionType: 'VALUATION',
          json: {
            dataAsOf: '2026-05-10',
            conclusion: { signal: 'BEARISH', confidence: 'MEDIUM' },
          },
        },
        3,
      ),
      evt(
        'section_complete',
        { sectionType: 'VALUATION', status: 'COMPLETED' },
        4,
      ),
      evt('cost_update', { totalUsd: 0.02, totalTokens: 100, toolCalls: 0 }, 5),
      evt(
        'done',
        {
          status: 'COMPLETED',
          result: {
            signal: 'BEARISH',
            confidence: 'MEDIUM',
            structuredJson: { dataAsOf: '2026-05-10' },
          },
        } as never,
        6,
      ),
    ];

    const { ctx, prismaCalls, sendCalls } = buildCtx({
      events,
      mode: 'single',
      analysisType: 'VALUATION',
      market: 'US',
      sections: [
        { id: 'sec-1', type: 'VALUATION', order: 0, status: 'PENDING' },
      ],
    });

    const result = await runAnalysisWorkflowAdapter(ctx);

    assert.equal(result.terminalStatus, 'COMPLETED');
    assert.equal(result.failedSectionTypes.length, 0);

    // Section row persisted COMPLETED.
    const sectionUpdate = prismaCalls.find(
      (c) => c.table === 'analysisSection' && c.method === 'update',
    );
    assert.ok(sectionUpdate, 'expected analysisSection.update');

    // Analysis finalize: overall* come from done.result, NOT summary fields.
    const analysisUpdate = prismaCalls.find(
      (c) => c.table === 'analysis' && c.method === 'update',
    );
    assert.ok(analysisUpdate, 'expected analysis.update');
    const data = (analysisUpdate!.args as { data: Record<string, unknown> })
      .data;
    assert.equal(data.status, 'COMPLETED');
    assert.equal(data.overallSignal, 'BEARISH');
    assert.equal(data.overallConfidence, 'MEDIUM');
    assert.equal(data.dataAsOf, '2026-05-10');
    assert.equal('summaryMarkdown' in data, false);
    assert.equal('summaryJson' in data, false);

    assert.ok(sendCalls.some((c) => c.type === 'done'));
  });
});
