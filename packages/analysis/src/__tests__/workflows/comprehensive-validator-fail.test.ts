/**
 * Coverage gap fix: the cross-dim validator's `overallStatus === 'FAIL'`
 * early-exit branch (comprehensive.ts ~928-959) had no direct test. It
 * emits an `error` event + `done` with PARTIAL_FAILED and returns without
 * running the summary phase.
 *
 * Isolated in its own file because mocking `validateCrossDim` would
 * interfere with the judge tests (which rely on the real validator
 * producing WARNING/DOWNGRADE conflicts to trigger selective judge).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ValidatorReport } from '../../contracts/cross-dim-validator';
import { SCHEMA_VERSION } from '../../contracts/analysis-result';
import type { EvidencePackV2 } from '../../contracts/evidence-pack-v2';
import type { SseEvent } from '../../contracts/sse-events';
import { ALL_DIMENSIONS } from '../../dimensions';
import { CN } from '../../markets/cn';
import type {
  AgentProvider,
  ProviderStreamResult,
} from '../../primitives/provider';

vi.mock('../../primitives/validate-cross-dim', () => ({
  validateCrossDim: vi.fn(),
  SectionForValidation: {} as never, // type-only export shim
}));

import { validateCrossDim } from '../../primitives/validate-cross-dim';
import { streamComprehensive } from '../../workflows/comprehensive';

const TODAY = '2026-05-15';
const URL = 'https://example.com/source';
const runId = 'run_validator_fail';

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

const validDimJson = JSON.stringify({
  schemaVersion: SCHEMA_VERSION,
  conclusion: {
    signal: 'BULLISH',
    confidence: 'HIGH',
    oneLiner: 'x',
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

function buildProvider(): AgentProvider {
  return {
    name: 'fake',
    stream: vi.fn(async (_sys: string, _user: string, onChunk) => {
      onChunk({ type: 'text', text: 'markdown' });
      const result: ProviderStreamResult = {
        text: 'markdown',
        citations: [],
        usage: { tokensIn: 50, tokensOut: 25 },
      };
      return result;
    }),
    complete: vi.fn(async () => ({
      text: validDimJson,
      usage: { tokensIn: 40, tokensOut: 20 },
    })),
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
): Promise<{ events: SseEvent[]; result: unknown }> {
  const events: SseEvent[] = [];
  while (true) {
    const next = await gen.next();
    if (next.done) return { events, result: next.value };
    events.push(next.value);
  }
}

const failReport: ValidatorReport = {
  overallStatus: 'FAIL',
  conflicts: [],
  downgradedDimensions: [],
  summary: {
    totalConflicts: 1,
    severityCounts: { WARNING: 0, DOWNGRADE: 0, FAIL: 1 },
    durationMs: 5,
  },
};

describe('streamComprehensive — cross-dim validator FAIL exit', () => {
  beforeEach(() => {
    vi.mocked(validateCrossDim).mockReset();
  });

  it('FAIL → emits error, done PARTIAL_FAILED, no summary, dims preserved', async () => {
    vi.mocked(validateCrossDim).mockReturnValue(failReport);

    const { events, result } = await collect(
      streamComprehensive(buildProvider(), cnInput, {
        runId,
        todayDate: TODAY,
        evidencePack: cnPack,
        marketProfile: CN,
      }),
    );

    // Validator was actually called (otherwise the mock returning FAIL
    // would be a vacuous assertion).
    expect(vi.mocked(validateCrossDim)).toHaveBeenCalledTimes(1);

    // Error event describing the FAIL.
    const errorEvent = events.find((e) => e.type === 'error');
    expect(errorEvent).toBeDefined();

    // No summary phase ran.
    expect(events.find((e) => e.type === 'summary_complete')).toBeUndefined();
    expect(events.find((e) => e.type === 'summary_chunk')).toBeUndefined();

    // done carries PARTIAL_FAILED and preserves completed dims.
    const done = events.find((e) => e.type === 'done') as
      | Extract<SseEvent, { type: 'done' }>
      | undefined;
    expect(done).toBeDefined();
    expect(done?.status).toBe('PARTIAL_FAILED');

    const r = result as {
      status: string;
      summary: unknown;
      perDimension: Map<string, unknown>;
    };
    expect(r.status).toBe('PARTIAL_FAILED');
    expect(r.summary).toBeNull();
    // Dims that completed are retained — not dropped — so the user can
    // still see per-section content even when the summary is suppressed.
    expect(r.perDimension.size).toBe(ALL_DIMENSIONS.length);
  });
});
