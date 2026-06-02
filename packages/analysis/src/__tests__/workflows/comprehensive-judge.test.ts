/**
 * RFC-10 P3 — streamComprehensive selective-judge phase.
 *
 * Mocks `runJudge` so we can deterministically control judge outcomes
 * (pass/fail, confidenceAdjustment) without hitting a real provider. The
 * evidence pack is supplied directly via Path A (`options.evidencePack`) so
 * the judge phase has a v2 pack to format, and `marketProfile: CN` gates the
 * cross-dim validator + selective-judge phase.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SCHEMA_VERSION } from '../../contracts/analysis-result';
import type { EvidencePackV2 } from '../../contracts/evidence-pack-v2';
import type { JudgeResult } from '../../contracts/judge-result';
import type { SseEvent } from '../../contracts/sse-events';
import { ALL_DIMENSIONS } from '../../dimensions';
import { CN } from '../../markets/cn';
import type {
  AgentProvider,
  ProviderStreamResult,
} from '../../primitives/provider';

// Path A v2 pack passed straight into streamComprehensive — has `quote` so it
// is not critically degraded, and gives the judge phase something to format.
const cnPack: EvidencePackV2 = {
  schemaVersion: 'evidence-pack-v2',
  symbol: '600519.SS',
  market: 'CN',
  capturedAt: '2026-05-15T00:00:00.000Z',
  facts: {
    quote: {
      value: 1820.5,
      asOf: '2026-05-15T00:00:00.000Z',
      retrievedAt: '2026-05-15T00:00:00.000Z',
      sourceUrl: 'https://qt.gtimg.cn/q=sh600519',
      sourceTier: 'B',
      unit: '元',
      currency: 'CNY',
    },
  },
  dataAvailability: { complete: ['quote'], missing: [], fallbacks: [] },
  citations: [],
  trace: { toolCalls: 1, durationMs: 5, costUsd: 0 },
};

vi.mock('../../primitives/judge', async (importOriginal) => {
  const original =
    (await importOriginal()) as typeof import('../../primitives/judge');
  return {
    ...original,
    runJudge: vi.fn(),
  };
});

import { runJudge } from '../../primitives/judge';
import { streamComprehensive } from '../../workflows/comprehensive';

const TODAY = '2026-05-15';
const URL = 'https://example.com/source';
const runId = 'run_judge_test';

const validDimJson = JSON.stringify({
  schemaVersion: SCHEMA_VERSION,
  conclusion: {
    signal: 'BULLISH',
    confidence: 'HIGH',
    oneLiner: '强看多。',
    evidence: [],
  },
  evidence: [
    {
      claim: 'x',
      citations: [
        { title: 'S', url: URL, sourceType: 'NEWS', retrievedAt: '2026-05-15T00:00:00Z' },
      ],
    },
  ],
  dataAvailability: { missingFields: [], reason: '' },
  dataAsOf: TODAY,
  disclaimer: 'd',
});

const validSummaryJson = JSON.stringify({
  overallSignal: 'BULLISH',
  overallConfidence: 'HIGH',
  oneLiner: 'ok',
  bullCase: ['a', 'b'],
  bearCase: ['x'],
  biggestRisk: 'r',
  valuationConclusion: 'v',
  suitableInvestorType: 's',
  watchlistWorthy: true,
  sectionSignals: ALL_DIMENSIONS.map((d) => ({
    type: d.type,
    signal: 'BULLISH',
    confidence: 'HIGH',
    oneLiner: 'o',
  })),
  evidence: [],
  dataAsOf: TODAY,
  disclaimer: '免责',
});

function buildProvider(symbol: string): AgentProvider {
  return {
    name: 'fake',
    stream: vi.fn(async (_sys: string, _user: string, onChunk) => {
      onChunk({ type: 'text', text: 'markdown' });
      onChunk({
        type: 'citation',
        citation: {
          title: 'Source',
          url: URL,
          sourceType: 'OTHER',
          retrievedAt: '2026-05-15T00:00:00Z',
        },
      });
      const result: ProviderStreamResult = {
        text: 'markdown',
        citations: [
          {
            title: 'Source',
            url: URL,
            sourceType: 'OTHER',
            retrievedAt: '2026-05-15T00:00:00Z',
          },
        ],
        usage: { tokensIn: 50, tokensOut: 25 },
      };
      void symbol;
      return result;
    }),
    complete: vi.fn(async (sys: string) => {
      const isSummary = sys.includes('ComprehensiveSummary JSON');
      if (isSummary)
        return { text: validSummaryJson, usage: { tokensIn: 40, tokensOut: 20 } };
      return { text: validDimJson, usage: { tokensIn: 40, tokensOut: 20 } };
    }),
    getModel: () => 'm',
    getUtilityModel: () => 'jm',
  };
}

const cnInput = {
  symbol: '600519.SS',
  market: 'CN',
  locale: 'zh-CN' as const,
};

async function collect(
  gen: AsyncGenerator<SseEvent, unknown, undefined>,
): Promise<SseEvent[]> {
  const events: SseEvent[] = [];
  while (true) {
    const next = await gen.next();
    if (next.done) return events;
    events.push(next.value);
  }
}

const judgePass: JudgeResult = {
  schemaVersion: 'judge-result-v1',
  pass: true,
  concerns: [],
  suggestedRevisions: [],
  confidenceAdjustment: 'KEEP',
};

const judgeDowngrade: JudgeResult = {
  schemaVersion: 'judge-result-v1',
  pass: false,
  concerns: ['PE 30x is unsupported by peerPE p50'],
  suggestedRevisions: ['revise to MEDIUM'],
  confidenceAdjustment: 'DOWNGRADE_TO_MEDIUM',
};

describe('streamComprehensive — selective judge phase (RFC-10 P3)', () => {
  beforeEach(() => {
    vi.mocked(runJudge).mockReset();
  });
  afterEach(() => {
    vi.mocked(runJudge).mockReset();
  });

  it('emits judge_start + judge_complete for each triggered dim', async () => {
    // All 9 dims are HIGH+BULLISH → on-strong default fires for every dim.
    vi.mocked(runJudge).mockResolvedValue({
      result: judgePass,
      trace: {
        tokensIn: 100,
        tokensOut: 30,
        costUsd: 0.001,
        durationMs: 50,
        llmCalls: 1,
        model: 'm',
      },
    });

    const events = await collect(
      streamComprehensive(buildProvider('600519.SS'), cnInput, {
        runId,
        todayDate: TODAY,
        evidencePack: cnPack,
        marketProfile: CN,
      }),
    );

    const judgeStarts = events.filter((e) => e.type === 'judge_start');
    const judgeCompletes = events.filter((e) => e.type === 'judge_complete');
    expect(judgeStarts).toHaveLength(ALL_DIMENSIONS.length);
    expect(judgeCompletes).toHaveLength(ALL_DIMENSIONS.length);
    expect(runJudge).toHaveBeenCalledTimes(ALL_DIMENSIONS.length);
    // judge_complete carries the result + trace fields.
    const sample = judgeCompletes[0] as Extract<SseEvent, { type: 'judge_complete' }>;
    expect(sample.result.pass).toBe(true);
    expect(sample.traceTokensIn).toBe(100);
    expect(sample.traceCostUsd).toBe(0.001);
  });

  it('propagates per-dim confidenceAdjustment into judge_complete events', async () => {
    // Mix: VALUATION downgraded, others KEEP. We assert the SSE event
    // payload; the dim-mutation side effect feeds the downstream summary
    // phase (covered end-to-end in P5 smoke).
    vi.mocked(runJudge).mockImplementation(async (_p, input) => {
      const adj =
        input.dimensionType === 'VALUATION' ? judgeDowngrade : judgePass;
      return {
        result: adj,
        trace: {
          tokensIn: 50,
          tokensOut: 20,
          costUsd: 0,
          durationMs: 10,
          llmCalls: 1,
        },
      };
    });

    const events = await collect(
      streamComprehensive(buildProvider('600519.SS'), cnInput, {
        runId,
        todayDate: TODAY,
        evidencePack: cnPack,
        marketProfile: CN,
      }),
    );

    const judgeCompletes = events.filter(
      (e) => e.type === 'judge_complete',
    ) as Array<Extract<SseEvent, { type: 'judge_complete' }>>;
    const byType = new Map(judgeCompletes.map((e) => [e.sectionType, e]));
    expect(byType.get('VALUATION')?.result.confidenceAdjustment).toBe(
      'DOWNGRADE_TO_MEDIUM',
    );
    expect(byType.get('FUNDAMENTAL')?.result.confidenceAdjustment).toBe(
      'KEEP',
    );
    expect(byType.get('VALUATION')?.result.concerns).toEqual([
      'PE 30x is unsupported by peerPE p50',
    ]);
  });

  it('judge throwing does NOT block summary phase', async () => {
    // First judge call throws; others pass. Summary should still generate.
    let n = 0;
    vi.mocked(runJudge).mockImplementation(async () => {
      n++;
      if (n === 1) throw new Error('synthetic judge failure');
      return {
        result: judgePass,
        trace: {
          tokensIn: 50,
          tokensOut: 20,
          costUsd: 0,
          durationMs: 10,
          llmCalls: 1,
        },
      };
    });

    const events = await collect(
      streamComprehensive(buildProvider('600519.SS'), cnInput, {
        runId,
        todayDate: TODAY,
        evidencePack: cnPack,
        marketProfile: CN,
      }),
    );

    const summaryComplete = events.find((e) => e.type === 'summary_complete');
    expect(summaryComplete).toBeDefined();
    const done = events.find((e) => e.type === 'done') as
      | Extract<SseEvent, { type: 'done' }>
      | undefined;
    expect(done?.status).toBe('COMPLETED');
    // The failed judge surfaces as a run-level warning, not an error.
    const warnings = done!.result.warnings ?? [];
    expect(
      warnings.some((w) => w.startsWith('[judge:fail:')),
    ).toBe(true);
  });

  it('respects JUDGE_CONCURRENCY (≤3 concurrent runJudge in flight)', async () => {
    let active = 0;
    let peak = 0;
    vi.mocked(runJudge).mockImplementation(async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return {
        result: judgePass,
        trace: {
          tokensIn: 10,
          tokensOut: 5,
          costUsd: 0,
          durationMs: 5,
          llmCalls: 1,
        },
      };
    });

    await collect(
      streamComprehensive(buildProvider('600519.SS'), cnInput, {
        runId,
        todayDate: TODAY,
        evidencePack: cnPack,
        marketProfile: CN,
      }),
    );

    expect(peak).toBeLessThanOrEqual(3);
    expect(runJudge).toHaveBeenCalledTimes(ALL_DIMENSIONS.length);
  });
});
