import { describe, expect, it, vi } from 'vitest';
import { SCHEMA_VERSION } from '../../contracts/analysis-result';
import type { SseEvent } from '../../contracts/sse-events';
import { ALL_DIMENSIONS, getDimension } from '../../dimensions';
const FUNDAMENTAL = getDimension('FUNDAMENTAL');
const TECHNICAL = getDimension('TECHNICAL');
import type { Dimension } from '../../dimensions/types';
import type {
  AgentProvider,
  ProviderStreamResult,
} from '../../primitives/provider';
import {
  runComprehensive,
  streamComprehensive,
} from '../../workflows/comprehensive';

const TODAY = '2026-05-10';
const URL = 'https://example.com/source';

const validDimJson = (): string =>
  JSON.stringify({
    schemaVersion: SCHEMA_VERSION,
    conclusion: {
      signal: 'BULLISH',
      confidence: 'HIGH',
      oneLiner: '基本面健康。',
      evidence: [],
    },
    evidence: [
      {
        claim: '收入增长',
        citations: [
          {
            title: 'S',
            url: URL,
            sourceType: 'NEWS',
            retrievedAt: '2026-05-10T00:00:00Z',
          },
        ],
      },
    ],
    dataAvailability: { missingFields: [], reason: '' },
    dataAsOf: TODAY,
    disclaimer: 'd',
  });

const validSummaryJson = (sectionTypes: string[]): string =>
  JSON.stringify({
    overallSignal: 'BULLISH',
    overallConfidence: 'HIGH',
    oneLiner: '综合看好。',
    bullCase: ['理由 A', '理由 B'],
    bearCase: ['风险 X'],
    biggestRisk: '宏观下行',
    valuationConclusion: '估值合理',
    suitableInvestorType: '稳健型',
    watchlistWorthy: true,
    sectionSignals: sectionTypes.map((t) => ({
      type: t,
      signal: 'BULLISH',
      confidence: 'HIGH',
      oneLiner: 'oneLiner',
    })),
    evidence: [],
    dataAsOf: TODAY,
    disclaimer: '免责',
  });

// RFC-04: provider.stream now accepts SystemPromptInput = string | TextBlock[].
// Tests written before RFC-04 assumed string; this helper normalizes to keep
// `sys.startsWith(...)` style detection working against both shapes.
function normalizeSystemPrompt(input: unknown): string {
  if (typeof input === 'string') return input;
  if (Array.isArray(input)) {
    return input
      .map((b) => (b && typeof b === 'object' && 'text' in b ? (b as { text: string }).text : ''))
      .join('\n');
  }
  return '';
}

function buildProvider(opts: {
  failOn?: string[]; // dimension types where stream() should throw
  streamCalls?: { type: string; sys: string }[];
}): AgentProvider {
  return {
    name: 'fake',
    stream: vi.fn(async (sysRaw: unknown, _user: string, onChunk) => {
      const sys = normalizeSystemPrompt(sysRaw);
      // Detect which dimension by inspecting the system prompt for one of
      // the per-dim header phrases.
      let detected = 'SUMMARY';
      for (const d of ALL_DIMENSIONS) {
        const dimSys = d.buildPrompts(
          { symbol: 'AAPL', market: 'US', locale: 'zh-CN' },
          { todayDate: TODAY },
        ).system;
        if (sys.startsWith(dimSys)) {
          detected = d.type;
          break;
        }
      }
      opts.streamCalls?.push({ type: detected, sys });
      if (opts.failOn?.includes(detected)) {
        throw new Error(`synthetic failure: ${detected}`);
      }
      const text = `# ${detected} markdown body`;
      onChunk({ type: 'text', text });
      onChunk({
        type: 'citation',
        citation: {
          title: 'Source',
          url: URL,
          sourceType: 'OTHER',
          retrievedAt: '2026-05-10T00:00:00Z',
        },
      });
      const result: ProviderStreamResult = {
        text,
        citations: [
          {
            title: 'Source',
            url: URL,
            sourceType: 'OTHER',
            retrievedAt: '2026-05-10T00:00:00Z',
          },
        ],
        usage: { tokensIn: 100, tokensOut: 50 },
      };
      return result;
    }),
    complete: vi.fn(async (sys: string) => {
      // Dispatch by which JSON the prompt asks for.
      const isSummary = sys.includes('ComprehensiveSummary JSON');
      if (isSummary) {
        const types = ALL_DIMENSIONS.map((d) => d.type);
        return {
          text: validSummaryJson(types),
          usage: { tokensIn: 80, tokensOut: 40 },
        };
      }
      return {
        text: validDimJson(),
        usage: { tokensIn: 80, tokensOut: 40 },
      };
    }),
    getModel: () => 'm',
    getUtilityModel: () => 'jm',
  };
}

const minimalInput = { symbol: 'AAPL', market: 'US', locale: 'zh-CN' as const };
const runId = 'run_comprehensive_test';

async function collect(
  gen: AsyncGenerator<SseEvent, unknown, undefined>,
): Promise<{ events: SseEvent[]; result: unknown }> {
  const events: SseEvent[] = [];
  while (true) {
    const next = await gen.next();
    if (next.done) return { events, result: next.value };
    events.push(next.value);
  }
}

describe('workflows/streamComprehensive — happy path', () => {
  it('runs all 9 dimensions then summary, returns COMPLETED', async () => {
    const calls: { type: string; sys: string }[] = [];
    const { events, result } = await collect(
      streamComprehensive(buildProvider({ streamCalls: calls }), minimalInput, {
        runId,
        todayDate: TODAY,
      }),
    );

    // 9 dim stream() calls + 1 summary stream() call
    expect(calls).toHaveLength(10);
    expect(calls[9]?.type).toBe('SUMMARY');

    const r = result as { status: string; perDimension: Map<string, unknown> };
    expect(r.status).toBe('COMPLETED');
    expect(r.perDimension.size).toBe(9);
    expect(events.find((e) => e.type === 'summary_complete')).toBeDefined();
  });

  it('emits 9 section_start events with order 0..8', async () => {
    const { events } = await collect(
      streamComprehensive(buildProvider({}), minimalInput, {
        runId,
        todayDate: TODAY,
      }),
    );
    const starts = events.filter((e) => e.type === 'section_start');
    expect(starts).toHaveLength(9);
    starts.forEach((e, i) => {
      if (e.type === 'section_start') expect(e.order).toBe(i);
    });
  });

  it('seq monotonically increases across all events', async () => {
    const { events } = await collect(
      streamComprehensive(buildProvider({}), minimalInput, {
        runId,
        todayDate: TODAY,
      }),
    );
    for (let i = 1; i < events.length; i++) {
      expect(events[i]!.seq).toBe((events[i - 1]?.seq ?? -1) + 1);
    }
  });

  it('summary_complete carries fullMarkdown and parsed json', async () => {
    const { events } = await collect(
      streamComprehensive(buildProvider({}), minimalInput, {
        runId,
        todayDate: TODAY,
      }),
    );
    const sc = events.find((e) => e.type === 'summary_complete');
    expect(sc).toBeDefined();
    if (sc?.type === 'summary_complete') {
      expect(sc.fullMarkdown).toContain('SUMMARY markdown');
      expect((sc.json as { overallSignal: string }).overallSignal).toBe(
        'BULLISH',
      );
    }
  });

  it('aggregates per-dim citations into result.citations', async () => {
    const { result } = await collect(
      streamComprehensive(buildProvider({}), minimalInput, {
        runId,
        todayDate: TODAY,
      }),
    );
    const r = result as { citations: { url: string }[] };
    // 8 dims each produce one citation for URL → dedup not done at workflow level
    expect(r.citations.length).toBeGreaterThanOrEqual(8);
  });
});

describe('workflows/streamComprehensive — partial failure (retry-once exhausted)', () => {
  it('records failure after both retry-once attempts fail, still summarizes', async () => {
    const { events, result } = await collect(
      streamComprehensive(
        buildProvider({ failOn: ['INDUSTRY'] }),
        minimalInput,
        { runId, todayDate: TODAY },
      ),
    );
    const r = result as {
      status: string;
      perDimension: Map<string, unknown>;
      failures: { type: string; error: string }[];
      partialDimensions: string[];
    };
    expect(r.status).toBe('PARTIAL_FAILED');
    expect(r.perDimension.size).toBe(8);
    expect(r.failures).toEqual([
      expect.objectContaining({ type: 'INDUSTRY' }),
    ]);
    expect(r.partialDimensions).toEqual(['INDUSTRY']);
    // retry-once means TWO error events for that dim (attempt 1 + attempt 2)
    const industryErrors = events.filter(
      (e) => e.type === 'error' && (e as { sectionType?: string }).sectionType === 'INDUSTRY',
    );
    expect(industryErrors.length).toBe(2);
    // summary still generated
    expect(events.find((e) => e.type === 'summary_complete')).toBeDefined();
  });
});

describe('workflows/streamComprehensive — retry-once recovers on second attempt', () => {
  it('treats dim as COMPLETED when first attempt fails but retry succeeds', async () => {
    // Custom provider: fail FUNDAMENTAL on first stream() call, succeed thereafter
    let fundamentalCallCount = 0;
    const baseProvider = buildProvider({});
    const wrapped: typeof baseProvider = {
      ...baseProvider,
      stream: vi.fn(async (sysRaw: unknown, user: string, onChunk) => {
        const sys = normalizeSystemPrompt(sysRaw);
        const isFundamental = sys.startsWith(
          FUNDAMENTAL.buildPrompts(
            { symbol: 'AAPL', market: 'US', locale: 'zh-CN' },
            { todayDate: TODAY },
          ).system,
        );
        if (isFundamental) {
          fundamentalCallCount++;
          if (fundamentalCallCount === 1) {
            throw new Error('transient flake');
          }
        }
        return baseProvider.stream(sys, user, onChunk);
      }),
    };
    const result = await runComprehensive(wrapped, minimalInput, {
      runId,
      todayDate: TODAY,
      dimensions: [FUNDAMENTAL, TECHNICAL],
    });
    expect(result.status).toBe('COMPLETED');
    expect(result.failures).toEqual([]);
    expect(result.perDimension.size).toBe(2);
    expect(fundamentalCallCount).toBe(2); // failed once, succeeded on retry
  });
});

describe('workflows/streamComprehensive — budget enforcement', () => {
  it('halts with BUDGET_EXHAUSTED when maxTokens cap is reached', async () => {
    // Per-dim: stream usage 100+50 = 150, complete usage 80+40 = 120 → 270/dim.
    // maxTokens: 200 → after dim 1 (270 > 200) check trips before dim 2.
    const { events, result } = await collect(
      streamComprehensive(buildProvider({}), minimalInput, {
        runId,
        todayDate: TODAY,
        budget: { maxTokens: 200 },
      }),
    );
    const r = result as { status: string; perDimension: Map<string, unknown>; summary: unknown };
    expect(r.status).toBe('BUDGET_EXHAUSTED');
    expect(r.perDimension.size).toBe(1); // only first dim completed
    expect(r.summary).toBeNull();
    // done event emitted with BUDGET_EXHAUSTED
    const done = events.find((e) => e.type === 'done');
    expect(done).toMatchObject({ type: 'done', status: 'BUDGET_EXHAUSTED' });
  });

  it('completes normally when budget is generous', async () => {
    const result = await runComprehensive(buildProvider({}), minimalInput, {
      runId,
      todayDate: TODAY,
      budget: { maxTokens: 100_000 },
    });
    expect(result.status).toBe('COMPLETED');
  });

  it('halts with BUDGET_EXHAUSTED when maxCostUsd cap is reached', async () => {
    // Per-dim cost (Sonnet defaults): stream 100/50 ≈ $0.00105 + complete
    // 80/40 ≈ $0.00084 → $0.00189/dim. maxCostUsd 0.003 → halts after dim 2.
    const result = await runComprehensive(buildProvider({}), minimalInput, {
      runId,
      todayDate: TODAY,
      budget: { maxCostUsd: 0.003 },
    });
    expect(result.status).toBe('BUDGET_EXHAUSTED');
    expect(result.perDimension.size).toBeLessThan(8);
    expect(result.trace.totalUsd).toBeGreaterThan(0);
  });

  it('halts with BUDGET_EXHAUSTED when maxToolCalls cap is reached', async () => {
    // Custom provider that emits toolUseCounts: { webSearch: 5 } per stream.
    const baseProvider = buildProvider({});
    const wrapped: typeof baseProvider = {
      ...baseProvider,
      stream: vi.fn(async (sys: any, user: string, onChunk: any) => {
        const r = await baseProvider.stream(sys, user, onChunk);
        return { ...r, toolUseCounts: { webSearch: 5 } };
      }),
    };
    const result = await runComprehensive(wrapped, minimalInput, {
      runId,
      todayDate: TODAY,
      budget: { maxToolCalls: 8 },
    });
    expect(result.status).toBe('BUDGET_EXHAUSTED');
    // First dim contributes 5 tool calls; check before dim 2 sees 5 < 8 →
    // continue. Dim 2 adds 5 → 10 > 8 → check before dim 3 trips.
    expect(result.perDimension.size).toBe(2);
    expect(result.trace.toolCalls).toBe(10);
  });
});

describe('workflows/streamComprehensive — trace USD totals', () => {
  it('trace.totalUsd is non-zero (Sonnet default rates)', async () => {
    const result = await runComprehensive(buildProvider({}), minimalInput, {
      runId,
      todayDate: TODAY,
    });
    // 8 dims × ~$0.00189 + summary ≈ $0.017
    expect(result.trace.totalUsd).toBeGreaterThan(0.01);
    expect(result.trace.totalUsd).toBeLessThan(0.02);
  });
});

describe('workflows/streamComprehensive — done event contract', () => {
  it('emits done with comprehensive payload on success', async () => {
    const { events } = await collect(
      streamComprehensive(buildProvider({}), minimalInput, {
        runId,
        todayDate: TODAY,
      }),
    );
    const done = events.find((e) => e.type === 'done');
    expect(done).toBeDefined();
    if (done?.type === 'done') {
      expect(done.status).toBe('COMPLETED');
      expect(done.result).toBeDefined();
      expect(done.result.structuredJson).not.toBeNull();
      expect(done.result.partialDimensions).toBeUndefined();
    }
  });

  it('emits done with FAILED status when fail-run dim fails', async () => {
    const failRunDim: Dimension = { ...FUNDAMENTAL, onFailure: 'fail-run' };
    const { events } = await collect(
      streamComprehensive(
        buildProvider({ failOn: ['FUNDAMENTAL'] }),
        minimalInput,
        { runId, todayDate: TODAY, dimensions: [failRunDim] },
      ),
    );
    const done = events.find((e) => e.type === 'done');
    expect(done).toMatchObject({ type: 'done', status: 'FAILED' });
    if (done?.type === 'done') {
      expect(done.result.structuredJson).toBeNull();
    }
  });
});

describe('workflows/streamComprehensive — Day 11.5a fixes', () => {
  it('parallel + budget throws (P1 #3)', async () => {
    await expect(
      runComprehensive(buildProvider({}), minimalInput, {
        runId,
        todayDate: TODAY,
        parallel: true,
        budget: { maxTokens: 1000 },
      }),
    ).rejects.toThrow(/parallel mode does not support budget/);
  });

  it('parallel + fail-run dim throws (P1 #3)', async () => {
    const failRunDim: Dimension = { ...FUNDAMENTAL, onFailure: 'fail-run' };
    await expect(
      runComprehensive(buildProvider({}), minimalInput, {
        runId,
        todayDate: TODAY,
        parallel: true,
        dimensions: [failRunDim],
      }),
    ).rejects.toThrow(/fail-run/);
  });

  it('BUDGET_EXHAUSTED partialDimensions includes unrun dims (P1 #4)', async () => {
    const result = await runComprehensive(buildProvider({}), minimalInput, {
      runId,
      todayDate: TODAY,
      budget: { maxTokens: 200 }, // halts after dim 1 (~270 tokens)
    });
    expect(result.status).toBe('BUDGET_EXHAUSTED');
    expect(result.partialDimensions.length).toBeGreaterThan(0);
    expect(result.partialDimensions).toContain('VALUATION');
    expect(result.partialDimensions).toContain('PORTFOLIO');
  });

  it('emits cost_update per section with cumulative totals (P1 #2)', async () => {
    const events: Array<{ type: string; totalUsd?: number; totalTokens?: number }> = [];
    const gen = streamComprehensive(buildProvider({}), minimalInput, {
      runId,
      todayDate: TODAY,
    });
    while (true) {
      const next = await gen.next();
      if (next.done) break;
      events.push(next.value as { type: string; totalUsd?: number; totalTokens?: number });
    }
    const costs = events.filter((e) => e.type === 'cost_update');
    // 8 per-dim + 2 summary cost_updates ≥ 10
    expect(costs.length).toBeGreaterThanOrEqual(10);
    let prev = 0;
    for (const c of costs) {
      expect(c.totalTokens).toBeGreaterThanOrEqual(prev);
      prev = c.totalTokens ?? 0;
    }
    expect(costs[costs.length - 1]?.totalUsd).toBeGreaterThan(0);
  });
});

describe('workflows/streamComprehensive — parallel mode (Day 11f)', () => {
  it('runs all 9 dims and reaches COMPLETED when parallel: true', async () => {
    const result = await runComprehensive(buildProvider({}), minimalInput, {
      runId,
      todayDate: TODAY,
      parallel: true,
    });
    expect(result.status).toBe('COMPLETED');
    expect(result.perDimension.size).toBe(9);
  });

  it('parallel mode marks failed dim as PARTIAL_FAILED, summary still runs', async () => {
    const result = await runComprehensive(
      buildProvider({ failOn: ['INDUSTRY'] }),
      minimalInput,
      { runId, todayDate: TODAY, parallel: true },
    );
    expect(result.status).toBe('PARTIAL_FAILED');
    expect(result.perDimension.size).toBe(8);
    expect(result.summary).not.toBeNull();
  });
});

describe('workflows/streamComprehensive — trace metrics (Day 11d)', () => {
  it('aggregates llmCalls / toolCalls / durationMs / perDimension', async () => {
    const result = await runComprehensive(buildProvider({}), minimalInput, {
      runId,
      todayDate: TODAY,
    });
    // Each dim: 1 stream + 1 complete = 2 llm calls (no repair); 9 dims = 18
    // Summary: 1 stream + 1 complete = 2 → grand total = 20
    expect(result.trace.llmCalls).toBe(20);
    // Tool calls: 0 because fake provider doesn't emit toolUseCounts
    expect(result.trace.toolCalls).toBe(0);
    expect(result.trace.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.trace.perDimension).toBeDefined();
    expect(Object.keys(result.trace.perDimension ?? {})).toHaveLength(9);
    const fund = result.trace.perDimension?.FUNDAMENTAL;
    expect(fund?.llmCalls).toBe(2);
    expect(fund?.tokensIn).toBeGreaterThan(0);
    expect(fund?.citationsCount).toBeGreaterThanOrEqual(0);
  });
});

describe('workflows/streamComprehensive — disclaimer override', () => {
  it('replaces summary disclaimer with DEFAULT_DISCLAIMER even if LLM returns custom text', async () => {
    // buildProvider's complete returns validSummaryJson which sets disclaimer to '免责'
    // After applyFixedDisclaimerToSummary it should be DEFAULT_DISCLAIMER instead.
    const { events } = await collect(
      streamComprehensive(buildProvider({}), minimalInput, {
        runId,
        todayDate: TODAY,
      }),
    );
    const sc = events.find((e) => e.type === 'summary_complete');
    if (sc?.type === 'summary_complete') {
      const json = sc.json as { disclaimer: string };
      expect(json.disclaimer).toBe(
        '免责声明：本报告由 AI 生成，不构成投资建议。投资有风险，入市需谨慎。',
      );
    }
  });
});

describe('workflows/streamComprehensive — fail-run dim', () => {
  it('halts on first failure when dim.onFailure==fail-run', async () => {
    // Wrap FUNDAMENTAL to fail-run
    const failRunFundamental: Dimension = {
      ...FUNDAMENTAL,
      onFailure: 'fail-run',
    };
    const { events, result } = await collect(
      streamComprehensive(
        buildProvider({ failOn: ['FUNDAMENTAL'] }),
        minimalInput,
        {
          runId,
          todayDate: TODAY,
          dimensions: [failRunFundamental, TECHNICAL],
        },
      ),
    );
    const r = result as { status: string; summary: unknown; failures: { type: string }[] };
    expect(r.status).toBe('FAILED');
    expect(r.summary).toBeNull();
    expect(r.failures).toEqual([expect.objectContaining({ type: 'FUNDAMENTAL' })]);
    expect(events.find((e) => e.type === 'summary_complete')).toBeUndefined();
  });
});

describe('workflows/streamComprehensive — empty / all-fail', () => {
  it('returns FAILED when no dimensions survive', async () => {
    const { result } = await collect(
      streamComprehensive(
        buildProvider({ failOn: ['FUNDAMENTAL'] }),
        minimalInput,
        { runId, todayDate: TODAY, dimensions: [FUNDAMENTAL] },
      ),
    );
    const r = result as { status: string; summary: unknown };
    expect(r.status).toBe('FAILED');
    expect(r.summary).toBeNull();
  });
});

describe('workflows/runComprehensive', () => {
  it('drains the generator and returns ComprehensiveResult', async () => {
    const result = await runComprehensive(buildProvider({}), minimalInput, {
      runId,
      todayDate: TODAY,
    });
    expect(result.status).toBe('COMPLETED');
    expect(result.summary).not.toBeNull();
    expect(result.perDimension.size).toBe(9);
  });
});


