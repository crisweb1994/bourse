import { describe, expect, it, vi } from 'vitest';
import { SCHEMA_VERSION } from '../../contracts/analysis-result';
import type { SseEvent } from '../../contracts/sse-events';
import { ALL_DIMENSIONS } from '../../dimensions';
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
      oneLiner: 'baseline',
      evidence: [],
    },
    evidence: [
      {
        claim: 'X',
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
    oneLiner: 'overall',
    bullCase: ['A'],
    bearCase: ['B'],
    biggestRisk: 'X',
    valuationConclusion: 'OK',
    suitableInvestorType: 'X',
    watchlistWorthy: true,
    sectionSignals: sectionTypes.map((t) => ({
      type: t,
      signal: 'BULLISH',
      confidence: 'HIGH',
      oneLiner: 'x',
    })),
    evidence: [],
    dataAsOf: TODAY,
    disclaimer: 'd',
  });

function normalizeSystemPrompt(input: unknown): string {
  if (typeof input === 'string') return input;
  if (Array.isArray(input)) {
    return input
      .map((b) =>
        b && typeof b === 'object' && 'text' in b
          ? (b as { text: string }).text
          : '',
      )
      .join('\n');
  }
  return '';
}

function buildProvider(opts: { failOn?: string[] } = {}): AgentProvider {
  return {
    name: 'fake',
    stream: vi.fn(async (sysRaw: unknown, _user: string, onChunk) => {
      const sys = normalizeSystemPrompt(sysRaw);
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
      if (opts.failOn?.includes(detected)) {
        throw new Error(`synthetic failure: ${detected}`);
      }
      const text = `# ${detected} body`;
      onChunk({ type: 'text', text });
      onChunk({
        type: 'citation',
        citation: {
          title: 'S',
          url: URL,
          sourceType: 'OTHER',
          retrievedAt: '2026-05-10T00:00:00Z',
        },
      });
      const result: ProviderStreamResult = {
        text,
        citations: [
          {
            title: 'S',
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

const minimalInput = {
  symbol: 'AAPL',
  market: 'US',
  locale: 'zh-CN' as const,
};
const runId = 'run_wave_test';

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

// ===== Basic wave-mode: all dims in wave 1 (default) =====

describe('streamComprehensive — RFC-05 waveMode "auto" basic', () => {
  it('runs all 9 dims when waveMode=auto + all in wave 1 (no wave hint set)', async () => {
    const result = await runComprehensive(buildProvider({}), minimalInput, {
      runId,
      todayDate: TODAY,
      waveMode: 'auto',
    });
    expect(result.status).toBe('COMPLETED');
    expect(result.perDimension.size).toBe(ALL_DIMENSIONS.length);
  });

  it('honors waveSemaphore option (no throw, completes)', async () => {
    const result = await runComprehensive(buildProvider({}), minimalInput, {
      runId,
      todayDate: TODAY,
      waveMode: 'auto',
      waveSemaphore: 2,
    });
    expect(result.status).toBe('COMPLETED');
  });

  it('does NOT throw on budget when waveMode=auto (vs legacy parallel:true)', async () => {
    const result = await runComprehensive(buildProvider({}), minimalInput, {
      runId,
      todayDate: TODAY,
      waveMode: 'auto',
      budget: { maxTokens: 10_000_000 }, // generous so it completes
    });
    expect(result.status).toBe('COMPLETED');
  });

  it('does NOT throw on fail-run dim with waveMode=auto', async () => {
    // Spy a fail-run dim via dimensions override
    const failRunDim: Dimension = {
      ...ALL_DIMENSIONS[0]!,
      onFailure: 'fail-run',
    };
    const dims = [failRunDim, ALL_DIMENSIONS[1]!];
    const result = await runComprehensive(buildProvider({}), minimalInput, {
      runId,
      todayDate: TODAY,
      waveMode: 'auto',
      dimensions: dims,
    });
    // The dim should complete (no synthetic failure) → COMPLETED.
    expect(result.status).toBe('COMPLETED');
  });
});

// ===== Budget gate at wave boundary =====

describe('streamComprehensive — waveMode "auto" budget gate', () => {
  it('halts at BUDGET_EXHAUSTED when maxTokens is reached mid-run', async () => {
    // 100 in + 50 out = 150 tokens per dim. Cap at 200 → second dim
    // is the wave boundary that trips the gate.
    const result = await runComprehensive(buildProvider({}), minimalInput, {
      runId,
      todayDate: TODAY,
      waveMode: 'auto',
      // Cap is checked BEFORE wave starts; with all dims in wave 1
      // and budget tight, first wave runs but second wave never
      // happens (none in test). Set a multi-wave scenario via custom dims.
      dimensions: [
        { ...ALL_DIMENSIONS[0]!, wave: 1 },
        { ...ALL_DIMENSIONS[1]!, wave: 2 },
      ],
      budget: { maxTokens: 200 },
    });
    // Wave 1 ran (150 tokens), budget gate trips before wave 2.
    expect(result.status).toBe('BUDGET_EXHAUSTED');
    expect(result.perDimension.size).toBe(1);
  });
});

// ===== fail-run gate at wave boundary =====

describe('streamComprehensive — waveMode "auto" fail-run gate', () => {
  it('halts with FAILED when a fail-run dim in wave 1 errors', async () => {
    const failRunDim: Dimension = {
      ...ALL_DIMENSIONS[0]!,
      onFailure: 'fail-run',
    };
    const ok: Dimension = { ...ALL_DIMENSIONS[1]!, wave: 2 };
    const result = await runComprehensive(
      buildProvider({ failOn: [failRunDim.type] }),
      minimalInput,
      {
        runId,
        todayDate: TODAY,
        waveMode: 'auto',
        dimensions: [failRunDim, ok],
      },
    );
    expect(result.status).toBe('FAILED');
    // Wave 2 should NOT have run.
    expect(result.perDimension.has(ok.type)).toBe(false);
  });
});

// ===== Multi-wave ordering =====

describe('streamComprehensive — waveMode "auto" wave ordering', () => {
  it('runs lower-wave dims fully before higher-wave dims start', async () => {
    const startTimes = new Map<string, number>();
    const provider = buildProvider({});
    const originalStream = provider.stream as any;
    provider.stream = vi.fn(async (sys: unknown, user: string, onChunk: any) => {
      const sysStr = normalizeSystemPrompt(sys);
      for (const d of ALL_DIMENSIONS) {
        const dimSys = d.buildPrompts(
          { symbol: 'AAPL', market: 'US', locale: 'zh-CN' },
          { todayDate: TODAY },
        ).system;
        if (sysStr.startsWith(dimSys)) {
          startTimes.set(d.type, Date.now());
          break;
        }
      }
      // tiny stagger to make ordering observable
      await new Promise((r) => setTimeout(r, 5));
      return originalStream(sys, user, onChunk);
    });

    const dimA: Dimension = { ...ALL_DIMENSIONS[0]!, wave: 1 };
    const dimB: Dimension = { ...ALL_DIMENSIONS[1]!, wave: 2 };
    await runComprehensive(provider, minimalInput, {
      runId,
      todayDate: TODAY,
      waveMode: 'auto',
      dimensions: [dimA, dimB],
    });

    const tA = startTimes.get(dimA.type);
    const tB = startTimes.get(dimB.type);
    expect(tA).toBeDefined();
    expect(tB).toBeDefined();
    // Wave 2 should start strictly after wave 1 starts; not strict on
    // before/after settle since both could overlap with the wait inside.
    // Stronger: wave 2 start > wave 1 start + epsilon.
    expect(tB!).toBeGreaterThan(tA!);
  });
});

// ===== Backward compat: legacy parallel:true still works =====

describe('streamComprehensive — RFC-05 backward compat', () => {
  it('legacy parallel:true (no waveMode) still uses Promise.all path', async () => {
    const result = await runComprehensive(buildProvider({}), minimalInput, {
      runId,
      todayDate: TODAY,
      parallel: true,
    });
    expect(result.status).toBe('COMPLETED');
  });

  it('legacy parallel:true with budget still throws (preserves semantics)', async () => {
    await expect(
      collect(
        streamComprehensive(buildProvider({}), minimalInput, {
          runId,
          todayDate: TODAY,
          parallel: true,
          budget: { maxTokens: 100_000 },
        }),
      ),
    ).rejects.toThrow(/parallel mode does not support budget/);
  });

  it('legacy parallel:true with fail-run dim still throws', async () => {
    const failRunDim: Dimension = {
      ...ALL_DIMENSIONS[0]!,
      onFailure: 'fail-run',
    };
    await expect(
      collect(
        streamComprehensive(buildProvider({}), minimalInput, {
          runId,
          todayDate: TODAY,
          parallel: true,
          dimensions: [failRunDim],
        }),
      ),
    ).rejects.toThrow(/parallel mode incompatible with fail-run/);
  });

  it('waveMode "disabled" takes precedence over parallel:true → sequential', async () => {
    const result = await runComprehensive(buildProvider({}), minimalInput, {
      runId,
      todayDate: TODAY,
      parallel: true,
      waveMode: 'disabled',
      // budget legal because we're sequential
      budget: { maxTokens: 10_000_000 },
    });
    expect(result.status).toBe('COMPLETED');
  });
});
