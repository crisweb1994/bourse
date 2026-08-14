import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type {
  AgentProvider,
  ComprehensiveOptions,
  DimensionInput,
  SseEvent,
} from '@bourse/analysis';
import { SECTION_ORDER, type SectionType } from '@bourse/shared-types';
import {
  runAnalysisWorkflowAdapter,
  type AdapterContext,
} from './analysis-workflow-adapter';

const RUN_ID = 'analysis-test-1';
const NOW = '2026-05-15T00:00:00.000Z';
const SOURCE_URL = 'https://example.com/source';

interface SentFrame {
  type: string;
  data: Record<string, unknown>;
}

interface DbCall {
  table: string;
  method: string;
  args: any;
}

function event<T extends SseEvent['type']>(
  type: T,
  data: Record<string, unknown>,
  seq: number,
): SseEvent {
  return { type, runId: RUN_ID, seq, ...data } as unknown as SseEvent;
}

function done(status: string, seq: number): SseEvent {
  return event('done', {
    status,
    result: {
      reportMarkdown: '',
      structuredJson: null,
      citations: [],
      status,
      confidence: 'LOW',
      trace: { tokensIn: 10, tokensOut: 20 },
      warnings: [],
    },
  }, seq);
}

function evidencePack() {
  return {
    schemaVersion: 'evidence-pack-v2' as const,
    symbol: 'AAPL',
    market: 'US' as const,
    capturedAt: NOW,
    facts: {},
    dataAvailability: { complete: [], missing: [], fallbacks: [] },
    citations: [],
    trace: { toolCalls: 0, durationMs: 0, costUsd: 0 },
  };
}

function sectionEvents(type: SectionType, order: number, seq: number): SseEvent[] {
  return [
    event('section_start', { sectionType: type, order }, seq),
    event('report_chunk', { sectionType: type, deltaText: `${type} report` }, seq + 1),
    event('citation', {
      sectionType: type,
      citation: {
        title: `${type} source`,
        url: SOURCE_URL,
        sourceType: 'FILING',
        retrievedAt: NOW,
      },
    }, seq + 2),
    event('structured_data', {
      sectionType: type,
      json: { type, summary: 'summary' },
    }, seq + 3),
    event('section_complete', {
      sectionType: type,
      status: 'COMPLETED',
      usage: { tokensIn: 2, tokensOut: 3 },
    }, seq + 4),
  ];
}

function persistedSection(type: SectionType) {
  const assessment: Record<SectionType, string> = {
    COMPANY_QUALITY: 'MIXED',
    INDUSTRY_POSITION: 'COMPETITIVE',
    VALUATION_SCENARIOS: 'FAIR',
    RISK_REGISTER: 'MEDIUM',
    MARKET_SIGNALS: 'NEUTRAL',
  };
  return {
    schemaVersion: 'analysis-section-v2',
    type,
    assessment: assessment[type],
    confidence: 'MEDIUM',
    summary: `${type} summary`,
    findings: [],
    limitations: [],
    dataAsOf: '2026-05-15',
    disclaimer: 'D',
  };
}

function buildContext(options: {
  events: SseEvent[];
  existingSnapshot?: any;
  evidencePack?: any;
  signal?: AbortSignal;
}) {
  const dbCalls: DbCall[] = [];
  const frames: SentFrame[] = [];
  const seenOptions: ComprehensiveOptions[] = [];
  const sections = SECTION_ORDER.map((type, order) => ({
    id: `section-${order}`,
    type,
    order,
    status: 'PENDING',
  }));

  const makeGenerator = async function* () {
    for (const item of options.events) yield item;
  };

  const ctx: AdapterContext = {
    analysisId: 'analysis-1',
    mode: 'QUICK',
    focusWindow: '90D',
    analysis: {
      id: 'analysis-1',
      mode: 'QUICK',
      focusWindow: '90D',
      question: '重点研究现金流质量',
      sections,
      stock: { symbol: 'AAPL', market: 'US', name: 'Apple' },
    },
    provider: {
      name: 'fake',
      stream: () => Promise.reject(new Error('not used')),
      complete: () => Promise.reject(new Error('not used')),
      getModel: () => 'fake-model',
      getUtilityModel: () => 'fake-model',
    } as unknown as AgentProvider,
    send: ((type: string, data: unknown) => {
      frames.push({ type, data: data as Record<string, unknown> });
    }) as AdapterContext['send'],
    prisma: {
      analysisSection: {
        updateMany: async (args: unknown) => {
          dbCalls.push({ table: 'analysisSection', method: 'updateMany', args });
          return { count: 1 };
        },
      },
      analysis: {
        updateMany: async (args: unknown) => {
          dbCalls.push({ table: 'analysis', method: 'updateMany', args });
          return { count: 1 };
        },
      },
      analysisEvidenceSnapshot: {
        findUnique: async () => options.existingSnapshot ?? null,
        create: async (args: unknown) => {
          dbCalls.push({ table: 'analysisEvidenceSnapshot', method: 'create', args });
          return {};
        },
      },
    } as unknown as AdapterContext['prisma'],
    evidencePackService: {
      buildForAnalysis: async () => ({
        pack: options.evidencePack,
        degraded: false,
        fallbackUsed: false,
        missingPrivateFields: [],
      }),
    } as never,
    aiModel: 'fake-model',
    signal: options.signal,
    _streamFactory: async function* (
      _provider: AgentProvider,
      _input: DimensionInput,
      workflowOptions: ComprehensiveOptions,
    ) {
      seenOptions.push(workflowOptions);
      yield* makeGenerator();
    },
  };

  return { ctx, dbCalls, frames, seenOptions };
}

describe('runAnalysisWorkflowAdapter', () => {
  it('persists one immutable V2 snapshot and the completed five-module report', async () => {
    const pack = evidencePack();
    const events: SseEvent[] = [
      event('evidence_pack_ready', { pack }, 1),
      ...SECTION_ORDER.flatMap((type, index) => sectionEvents(type, index, 10 + index * 5)),
      event('summary_chunk', { deltaText: '综合结论' }, 40),
      event('summary_complete', {
        fullMarkdown: '综合结论',
        json: {
          headline: '综合结论',
          signal: null,
          confidence: 'LOW',
          rationale: [],
          counterpoints: [],
          changeConditions: [],
          missingSections: [],
          dataAsOf: '2026-05-15',
          disclaimer: 'D',
        },
      }, 41),
      done('COMPLETED', 42),
    ];
    const { ctx, dbCalls, frames, seenOptions } = buildContext({
      events,
      evidencePack: pack,
    });

    const result = await runAnalysisWorkflowAdapter(ctx);

    assert.equal(result.terminalStatus, 'COMPLETED');
    assert.deepEqual(result.failedSectionTypes, []);
    assert.equal(frames.at(-1)?.type, 'done');
    assert.equal(frames.filter((frame) => frame.type === 'section_complete').length, 5);
    assert.equal(dbCalls.filter((call) => call.table === 'analysisEvidenceSnapshot').length, 1);
    assert.equal(seenOptions[0]?.evidencePack, pack);
    assert.equal(seenOptions[0]?.mode, 'QUICK');
    assert.equal(seenOptions[0]?.focusWindow, '90D');
  });

  it('keeps completed modules and records failed or skipped modules as partial failure', async () => {
    const events: SseEvent[] = [
      event('section_start', { sectionType: 'COMPANY_QUALITY', order: 0 }, 1),
      event('error', { sectionType: 'COMPANY_QUALITY', message: 'provider failed', recoverable: false }, 2),
      event('section_complete', { sectionType: 'COMPANY_QUALITY', status: 'FAILED' }, 3),
      event('section_start', { sectionType: 'INDUSTRY_POSITION', order: 1 }, 4),
      event('section_skipped', {
        sectionType: 'INDUSTRY_POSITION',
        reason: 'INSUFFICIENT_REQUIRED_FACTS',
        missingFields: ['profile'],
      }, 5),
      event('section_complete', { sectionType: 'INDUSTRY_POSITION', status: 'SKIPPED' }, 6),
      done('PARTIAL_FAILED', 7),
    ];
    const { ctx, frames } = buildContext({ events });

    const result = await runAnalysisWorkflowAdapter(ctx);

    assert.equal(result.terminalStatus, 'PARTIAL_FAILED');
    assert.deepEqual(result.failedSectionTypes, [
      'COMPANY_QUALITY',
      'INDUSTRY_POSITION',
      'VALUATION_SCENARIOS',
      'RISK_REGISTER',
      'MARKET_SIGNALS',
    ]);
    assert.ok(frames.some((frame) => frame.type === 'section_skipped'));
    assert.ok(frames.some((frame) => frame.type === 'error'));
  });

  it('reuses an existing immutable snapshot when retrying an analysis', async () => {
    const pack = evidencePack();
    const { ctx, dbCalls, seenOptions } = buildContext({
      events: [done('FAILED', 1)],
      existingSnapshot: { payload: pack, degraded: true },
      evidencePack: { ...pack, symbol: 'SHOULD_NOT_BE_USED' },
    });

    const result = await runAnalysisWorkflowAdapter(ctx);

    assert.equal(result.terminalStatus, 'FAILED');
    assert.equal(dbCalls.some((call) => call.table === 'analysisEvidenceSnapshot' && call.method === 'create'), false);
    assert.equal(seenOptions[0]?.evidencePack, pack);
  });

  it('passes completed module results to retry without rerunning them', async () => {
    const pack = evidencePack();
    const { ctx, seenOptions, frames } = buildContext({
      events: [
        ...sectionEvents('MARKET_SIGNALS', 4, 1),
        event('summary_complete', {
          fullMarkdown: '综合结论',
          json: {
            headline: '综合结论', signal: null, confidence: 'LOW',
            rationale: [], counterpoints: [], changeConditions: [],
            missingSections: [], dataAsOf: '2026-05-15', disclaimer: 'D',
          },
        }, 6),
        done('COMPLETED', 7),
      ],
      existingSnapshot: { payload: pack, degraded: false },
    });
    ctx.analysis.sections = ctx.analysis.sections.map((section) =>
      section.type === 'MARKET_SIGNALS'
        ? section
        : {
            ...section,
            status: 'COMPLETED',
            reportMarkdown: `${section.type} report`,
            structuredJson: persistedSection(section.type as SectionType),
          },
    );

    const result = await runAnalysisWorkflowAdapter(ctx);

    assert.equal(result.terminalStatus, 'COMPLETED');
    assert.deepEqual(
      seenOptions[0]?.existingResults?.map((item) => item.type),
      ['COMPANY_QUALITY', 'INDUSTRY_POSITION', 'VALUATION_SCENARIOS', 'RISK_REGISTER'],
    );
    assert.equal(frames.filter((frame) => frame.type === 'section_start').length, 1);
  });

  it('marks the run cancelled and preserves already emitted content on abort', async () => {
    const controller = new AbortController();
    const { ctx, dbCalls, frames } = buildContext({
      events: [],
      signal: controller.signal,
    });
    ctx._streamFactory = async function* () {
      controller.abort();
      const error = new Error('aborted');
      error.name = 'AbortError';
      throw error;
    };

    const result = await runAnalysisWorkflowAdapter(ctx);

    assert.equal(result.terminalStatus, 'CANCELLED');
    assert.equal(frames.at(-1)?.data.status, 'CANCELLED');
    assert.ok(dbCalls.some((call) => call.table === 'analysis' && call.method === 'updateMany'));
  });
});
