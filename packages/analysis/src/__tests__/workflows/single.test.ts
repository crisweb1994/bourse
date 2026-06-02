import { describe, expect, it, vi } from 'vitest';
import { SCHEMA_VERSION } from '../../contracts/analysis-result';
import { getDimension } from '../../dimensions';
const FUNDAMENTAL = getDimension('FUNDAMENTAL');
import type {
  AgentProvider,
  ProviderStreamResult,
} from '../../primitives/provider';
import { runSingle, streamSingle } from '../../workflows/single';

const URL = 'https://example.com/source';

const validJson = (urls: string[]): string =>
  JSON.stringify({
    schemaVersion: SCHEMA_VERSION,
    conclusion: {
      signal: 'BULLISH',
      confidence: 'HIGH',
      oneLiner: '基本面健康',
      evidence: [],
    },
    evidence: [
      {
        claim: '收入增长',
        citations: [
          {
            title: 'S',
            url: urls[0] ?? URL,
            sourceType: 'NEWS',
            retrievedAt: '2026-05-10T00:00:00Z',
          },
        ],
      },
    ],
    dataAvailability: { missingFields: [], reason: '' },
    dataAsOf: '2026-05-10',
    disclaimer: 'd',
  });

function fakeProvider(): AgentProvider {
  return {
    name: 'fake',
    stream: vi.fn(async (_sys, _user, onChunk) => {
      onChunk({ type: 'text', text: '# report' });
      const r: ProviderStreamResult = {
        text: '# report',
        citations: [
          { title: 'S', url: URL, sourceType: 'OTHER', retrievedAt: '2026-05-10T00:00:00Z' },
        ],
        usage: { tokensIn: 100, tokensOut: 50 },
      };
      return r;
    }),
    complete: vi.fn(async () => ({
      text: validJson([URL]),
      usage: { tokensIn: 80, tokensOut: 40 },
    })),
    getModel: () => 'm',
    getUtilityModel: () => 'jm',
  };
}

describe('workflows/runSingle', () => {
  it('returns AnalysisResult with single-dim StructuredJson', async () => {
    const result = await runSingle(
      fakeProvider(),
      FUNDAMENTAL,
      { symbol: 'AAPL', market: 'US', locale: 'zh-CN' },
      { runId: 'single_1', todayDate: '2026-05-10' },
    );
    expect(result.status).toBe('COMPLETED');
    expect(result.signal).toBe('BULLISH');
    expect(result.confidence).toBe('HIGH');
    expect(result.structuredJson).not.toBeNull();
    if (result.structuredJson && 'schemaVersion' in result.structuredJson) {
      expect(result.structuredJson.schemaVersion).toBe(SCHEMA_VERSION);
    }
    expect(result.trace.llmCalls).toBe(2); // stream + complete
  });
});

describe('workflows/runSingle — budget enforcement (Day 11.5a P1 #1)', () => {
  it('returns BUDGET_EXHAUSTED when section overshoots maxTokens', async () => {
    const result = await runSingle(
      fakeProvider(),
      FUNDAMENTAL,
      { symbol: 'AAPL', market: 'US', locale: 'zh-CN' },
      {
        runId: 'single_budget',
        todayDate: '2026-05-10',
        budget: { maxTokens: 100 }, // section uses ~270, overshoots
      },
    );
    expect(result.status).toBe('BUDGET_EXHAUSTED');
    expect(result.warnings[0]).toContain('maxTokens');
  });

  it('returns BUDGET_EXHAUSTED when section overshoots maxCostUsd', async () => {
    const result = await runSingle(
      fakeProvider(),
      FUNDAMENTAL,
      { symbol: 'AAPL', market: 'US', locale: 'zh-CN' },
      {
        runId: 'single_usd',
        todayDate: '2026-05-10',
        budget: { maxCostUsd: 0.0000001 },
      },
    );
    expect(result.status).toBe('BUDGET_EXHAUSTED');
  });

  it('emits cost_update event with cumulative totals', async () => {
    const events: Array<{ type: string; totalUsd?: number; totalTokens?: number }> = [];
    const gen = streamSingle(
      fakeProvider(),
      FUNDAMENTAL,
      { symbol: 'AAPL', market: 'US', locale: 'zh-CN' },
      { runId: 'single_cost', todayDate: '2026-05-10' },
    );
    while (true) {
      const next = await gen.next();
      if (next.done) break;
      events.push(next.value as { type: string; totalUsd?: number; totalTokens?: number });
    }
    const cost = events.find((e) => e.type === 'cost_update');
    expect(cost).toBeDefined();
    expect(cost?.totalTokens).toBeGreaterThan(0);
  });
});

describe('workflows/streamSingle — Path A evidence pack', () => {
  function v2Pack(): unknown {
    return {
      schemaVersion: 'evidence-pack-v2',
      symbol: 'AAPL',
      market: 'US',
      capturedAt: '2026-05-10T00:00:00.000Z',
      facts: {
        quote: {
          value: 228.5,
          asOf: '2026-05-10T00:00:00.000Z',
          retrievedAt: '2026-05-10T00:00:00.000Z',
          sourceUrl: 'https://finance.yahoo.com/quote/AAPL',
          sourceTier: 'B',
        },
      },
      dataAvailability: { complete: ['quote'], missing: [], fallbacks: [] },
      citations: [],
      trace: { toolCalls: 0, durationMs: 0, costUsd: 0 },
    };
  }

  it('yields evidence_pack_ready and injects the pack into the dim system prompt', async () => {
    const pack = v2Pack();
    const provider = fakeProvider();
    const events: Array<{ type: string; pack?: unknown }> = [];
    const gen = streamSingle(
      provider,
      FUNDAMENTAL,
      { symbol: 'AAPL', market: 'US', locale: 'zh-CN' },
      {
        runId: 'single_patha',
        todayDate: '2026-05-10',
        evidencePack: pack as never,
      },
    );
    while (true) {
      const n = await gen.next();
      if (n.done) break;
      events.push(n.value as { type: string; pack?: unknown });
    }
    // pack surfaced for the frontend (degradedSource UI)
    const ready = events.find((e) => e.type === 'evidence_pack_ready');
    expect(ready?.pack).toBe(pack);
    // pack reached the dim system prompt (SystemPromptInput is an array of blocks)
    const sysArg = (provider.stream as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const sysText = Array.isArray(sysArg)
      ? sysArg.map((b: { text: string }) => b.text).join('\n')
      : String(sysArg);
    expect(sysText).toContain('【事实包 (EvidencePack v2)】');
    expect(sysText).toContain('- quote: 228.5');
  });
});

describe('workflows/streamSingle — events', () => {
  it('terminates with done event carrying result', async () => {
    const events = [];
    const gen = streamSingle(
      fakeProvider(),
      FUNDAMENTAL,
      { symbol: 'AAPL', market: 'US', locale: 'zh-CN' },
      { runId: 'single_2', todayDate: '2026-05-10' },
    );
    let final;
    while (true) {
      const next = await gen.next();
      if (next.done) {
        final = next.value;
        break;
      }
      events.push(next.value);
    }
    const done = events[events.length - 1];
    expect(done?.type).toBe('done');
    expect(final?.status).toBe('COMPLETED');
  });

  it('emits FAILED done when streamDimension throws', async () => {
    const erroring: AgentProvider = {
      name: 'fake',
      stream: vi.fn(async () => {
        throw new Error('boom');
      }),
      complete: vi.fn(),
      getModel: () => 'm',
      getUtilityModel: () => 'jm',
    };
    const result = await runSingle(
      erroring,
      FUNDAMENTAL,
      { symbol: 'AAPL', market: 'US', locale: 'zh-CN' },
      { runId: 'single_3', todayDate: '2026-05-10' },
    );
    expect(result.status).toBe('FAILED');
    expect(result.structuredJson).toBeNull();
  });
});
