import { describe, expect, it, vi } from 'vitest';
import { SCHEMA_VERSION } from '../../contracts/analysis-result';
import type { SseEvent } from '../../contracts/sse-events';
import { getDimension } from '../../dimensions';
const FUNDAMENTAL = getDimension('FUNDAMENTAL');
import { DEFAULT_DISCLAIMER } from '../../primitives/disclaimer';
import type {
  AgentProvider,
  ProviderCompleteResult,
  ProviderStreamResult,
} from '../../primitives/provider';
import { streamDimension } from '../../primitives/stream-dimension';

// Standard URL used by validJson + fakeProvider's default streamFinal so
// citations are always present and within allowedUrls — keeping the tests
// focused on streaming behavior rather than tripping the citation policy
// (which is now enforced by default; see __tests__/primitives/run-dimension.test
// for explicit policy-enforcement tests).
const STANDARD_URL = 'https://example.com/source';
const STANDARD_CITATION = {
  title: 'Source',
  url: STANDARD_URL,
  sourceType: 'OTHER' as const,
  retrievedAt: '2026-05-10T00:00:00Z',
};

const validJson = (urls: string[] = [STANDARD_URL]): string =>
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
            title: 'Source',
            url: urls[0] ?? STANDARD_URL,
            sourceType: 'NEWS',
            retrievedAt: '2026-05-10T00:00:00Z',
          },
        ],
      },
    ],
    dataAvailability: { missingFields: [], reason: 'ok' },
    dataAsOf: '2026-05-10',
    disclaimer: 'LLM-generated disclaimer that should be overridden',
  });

function fakeProvider(opts: {
  chunks?: Array<{ type: 'text'; text: string } | { type: 'citation'; citation: ProviderStreamResult['citations'][number] }>;
  streamFinal?: ProviderStreamResult;
  completeResult?: ProviderCompleteResult;
} = {}): AgentProvider {
  // Captures the citations from the most recent stream() so that complete()
  // can produce structured JSON whose evidence cites URLs that are in
  // allowedUrls (avoids tripping the now-enforced citation policy).
  let lastStreamCitations: ProviderStreamResult['citations'] = [];
  return {
    name: 'fake',
    stream: vi.fn(async (_sys, _user, onChunk) => {
      for (const c of opts.chunks ?? []) {
        onChunk(c);
      }
      const accumulatedCitations = (opts.chunks ?? [])
        .filter((c): c is { type: 'citation'; citation: ProviderStreamResult['citations'][number] } => c.type === 'citation')
        .map((c) => c.citation);
      const result = opts.streamFinal ?? {
        text: (opts.chunks ?? [])
          .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
          .map((c) => c.text)
          .join(''),
        citations: accumulatedCitations.length > 0 ? accumulatedCitations : [STANDARD_CITATION],
        usage: { tokensIn: 100, tokensOut: 50 },
      };
      lastStreamCitations = result.citations;
      return result;
    }),
    complete: vi.fn(async () =>
      opts.completeResult ?? {
        text: validJson(lastStreamCitations.map((c) => c.url)),
        usage: { tokensIn: 80, tokensOut: 40 },
      },
    ),
    getModel: () => 'm',
    getUtilityModel: () => 'jm',
  };
}

async function collect(gen: AsyncGenerator<SseEvent>): Promise<SseEvent[]> {
  const events: SseEvent[] = [];
  for await (const evt of gen) events.push(evt);
  return events;
}

const runId = 'run_test_1';
const minimalInput = { symbol: 'AAPL', market: 'US', locale: 'zh-CN' as const };

describe('primitives/streamDimension — event order', () => {
  it('emits the canonical event sequence', async () => {
    const url = 'https://example.com/a';
    const events = await collect(
      streamDimension(
        fakeProvider({
          chunks: [
            { type: 'text', text: 'hello ' },
            { type: 'text', text: 'world' },
            {
              type: 'citation',
              citation: { title: 'S', url, sourceType: 'OTHER', retrievedAt: '2026-05-10T00:00:00Z' },
            },
          ],
        }),
        FUNDAMENTAL,
        minimalInput,
        { runId, todayDate: '2026-05-10' },
      ),
    );

    const types = events.map((e) => e.type);
    // Day 11.5a: cost_update emission moved to workflow layer (with
    // run-wide cumulative totals). streamDimension stays section-scoped.
    expect(types).toEqual([
      'section_start',
      'report_chunk',
      'report_chunk',
      'citation',
      'report_complete',
      'structured_data',
      'section_complete',
    ]);
  });

  it('section_start carries order field', async () => {
    const events = await collect(
      streamDimension(fakeProvider({}), FUNDAMENTAL, minimalInput, {
        runId,
        order: 3,
        todayDate: '2026-05-10',
      }),
    );
    expect(events[0]).toMatchObject({ type: 'section_start', order: 3 });
  });
});

describe('primitives/streamDimension — runId & seq', () => {
  it('every event has runId and monotonically increasing seq', async () => {
    const events = await collect(
      streamDimension(
        fakeProvider({
          chunks: [
            { type: 'text', text: 'abc' },
            { type: 'text', text: 'def' },
          ],
        }),
        FUNDAMENTAL,
        minimalInput,
        { runId, todayDate: '2026-05-10' },
      ),
    );
    expect(events.every((e) => e.runId === runId)).toBe(true);
    const seqs = events.map((e) => e.seq);
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBe((seqs[i - 1] ?? -1) + 1);
    }
  });

  it('honors startSeq offset', async () => {
    const events = await collect(
      streamDimension(fakeProvider({}), FUNDAMENTAL, minimalInput, {
        runId,
        startSeq: 100,
        todayDate: '2026-05-10',
      }),
    );
    expect(events[0]?.seq).toBe(100);
  });
});

describe('primitives/streamDimension — payloads', () => {
  it('report_complete carries the full markdown', async () => {
    const events = await collect(
      streamDimension(
        fakeProvider({
          chunks: [
            { type: 'text', text: 'foo ' },
            { type: 'text', text: 'bar' },
          ],
        }),
        FUNDAMENTAL,
        minimalInput,
        { runId, todayDate: '2026-05-10' },
      ),
    );
    const complete = events.find((e) => e.type === 'report_complete');
    expect(complete).toMatchObject({ fullMarkdown: 'foo bar' });
  });

  it('structured_data carries parsed JSON matching schema', async () => {
    const events = await collect(
      streamDimension(fakeProvider({}), FUNDAMENTAL, minimalInput, {
        runId,
        todayDate: '2026-05-10',
      }),
    );
    const struct = events.find((e) => e.type === 'structured_data');
    expect(struct).toBeDefined();
    if (struct?.type === 'structured_data') {
      expect(struct.json).toMatchObject({
        schemaVersion: SCHEMA_VERSION,
        conclusion: { signal: 'BULLISH', confidence: 'HIGH' },
      });
    }
  });

  it('section_complete includes per-section usage', async () => {
    const events = await collect(
      streamDimension(
        fakeProvider({
          streamFinal: {
            text: 'r',
            citations: [STANDARD_CITATION],
            usage: { tokensIn: 100, tokensOut: 50 },
          },
          completeResult: {
            text: validJson([STANDARD_URL]),
            usage: { tokensIn: 80, tokensOut: 40 },
          },
        }),
        FUNDAMENTAL,
        minimalInput,
        { runId, todayDate: '2026-05-10' },
      ),
    );
    const done = events.find((e) => e.type === 'section_complete');
    expect(done).toMatchObject({
      status: 'COMPLETED',
      usage: { tokensIn: 180, tokensOut: 90 },
    });
  });

  it('does NOT emit cost_update from streamDimension (workflow layer responsibility)', async () => {
    // Day 11.5a P1 #2: cost_update is emitted by streamComprehensive /
    // streamSingle so it can carry run-wide cumulative totals + real
    // USD. streamDimension only emits per-section data.
    const events = await collect(
      streamDimension(
        fakeProvider({
          streamFinal: {
            text: 'r',
            citations: [STANDARD_CITATION],
            usage: { tokensIn: 100, tokensOut: 50 },
          },
          completeResult: {
            text: validJson([STANDARD_URL]),
            usage: { tokensIn: 80, tokensOut: 40 },
          },
        }),
        FUNDAMENTAL,
        minimalInput,
        { runId, todayDate: '2026-05-10' },
      ),
    );
    const costs = events.filter((e) => e.type === 'cost_update');
    expect(costs).toHaveLength(0);
  });
});

describe('primitives/streamDimension — error paths', () => {
  it('rejects bad input synchronously via inputSchema', async () => {
    const gen = streamDimension(fakeProvider({}), FUNDAMENTAL, {
      symbol: '',
      market: 'US',
      locale: 'zh-CN',
    }, { runId, todayDate: '2026-05-10' });
    await expect(gen.next()).rejects.toThrow();
  });

  it('propagates provider stream errors', async () => {
    const provider: AgentProvider = {
      name: 'fake',
      stream: vi.fn(async () => {
        throw new Error('upstream boom');
      }),
      complete: vi.fn(),
      getModel: () => 'm',
      getUtilityModel: () => 'jm',
    };
    const gen = streamDimension(provider, FUNDAMENTAL, minimalInput, {
      runId,
      todayDate: '2026-05-10',
    });
    await expect(collect(gen)).rejects.toThrow('upstream boom');
  });
});

describe('primitives/streamDimension — RFC-02 §13 EvidencePack injection', () => {
  const evidencePackFixture = {
    schemaVersion: 'evidence-pack-v2' as const,
    symbol: '600519.SS',
    market: 'CN' as const,
    capturedAt: '2026-05-14T08:00:00.000Z',
    facts: {
      quote: {
        value: 1820.5,
        asOf: '2026-05-14T08:00:00.000Z',
        retrievedAt: '2026-05-14T08:00:00.000Z',
        sourceUrl: 'https://qt.gtimg.cn/q=sh600519',
        sourceTier: 'B' as const,
      },
    },
    dataAvailability: {
      complete: ['quote'],
      missing: [{ field: 'recentNews', reason: 'tool not implemented' }],
      fallbacks: [],
    },
    citations: [],
    trace: { toolCalls: 1, durationMs: 50, costUsd: 0 },
  };

  it('prepends 事实包 block when options.evidencePack is v2', async () => {
    const provider = fakeProvider({
      chunks: [{ type: 'text', text: '# report' }],
    });
    await collect(
      streamDimension(provider, FUNDAMENTAL, minimalInput, {
        runId,
        todayDate: '2026-05-10',
        evidencePack: evidencePackFixture,
      }),
    );
    const streamMock = provider.stream as unknown as ReturnType<typeof vi.fn>;
    // RFC-04: provider.stream now receives SystemTextBlock[] (cache enabled
    // by default) — flatten to a single string for assertion compatibility.
    const sysRaw = streamMock.mock.calls[0][0];
    const systemPrompt: string =
      typeof sysRaw === 'string'
        ? sysRaw
        : (sysRaw as Array<{ text: string }>).map((b) => b.text).join('\n');
    expect(systemPrompt).toContain('【事实包 (EvidencePack v2)】');
    expect(systemPrompt).toContain('600519.SS');
    expect(systemPrompt).toContain('- quote: 1820.5');
    expect(systemPrompt).toContain('【数据缺失·可补充】');
    expect(systemPrompt).toContain('recentNews');
    expect(systemPrompt).toContain('【引用规则】');
  });

  it('places 事实包 block AFTER the dim system prompt body (RFC-04 cache order)', async () => {
    // RFC-04 inverted the original RFC-02 order. The stable dim system +
    // commonSuffix must come FIRST so the cache_control breakpoint covers
    // only stable content — otherwise the per-symbol EvidencePack would
    // poison the cache key and we'd never hit a cached prefix.
    const provider = fakeProvider({ chunks: [{ type: 'text', text: '# r' }] });
    await collect(
      streamDimension(provider, FUNDAMENTAL, minimalInput, {
        runId,
        todayDate: '2026-05-10',
        evidencePack: evidencePackFixture,
      }),
    );
    const streamMock = provider.stream as unknown as ReturnType<typeof vi.fn>;
    // RFC-04: provider.stream now receives SystemTextBlock[] (cache enabled
    // by default) — flatten to a single string for assertion compatibility.
    const sysRaw = streamMock.mock.calls[0][0];
    const systemPrompt: string =
      typeof sysRaw === 'string'
        ? sysRaw
        : (sysRaw as Array<{ text: string }>).map((b) => b.text).join('\n');
    const blockIdx = systemPrompt.indexOf('【事实包');
    // FUNDAMENTAL's system prompt has a Chinese 基本面 keyword somewhere.
    const dimBodyIdx = systemPrompt.indexOf('基本面');
    expect(blockIdx).toBeGreaterThanOrEqual(0);
    expect(dimBodyIdx).toBeGreaterThanOrEqual(0);
    // RFC-04: dim body / common-suffix come BEFORE the evidence block.
    expect(dimBodyIdx).toBeLessThan(blockIdx);
  });

  it('does NOT inject block when evidencePack is omitted (backward compat)', async () => {
    const provider = fakeProvider({ chunks: [{ type: 'text', text: '# r' }] });
    await collect(
      streamDimension(provider, FUNDAMENTAL, minimalInput, {
        runId,
        todayDate: '2026-05-10',
      }),
    );
    const streamMock = provider.stream as unknown as ReturnType<typeof vi.fn>;
    // RFC-04: provider.stream now receives SystemTextBlock[] (cache enabled
    // by default) — flatten to a single string for assertion compatibility.
    const sysRaw = streamMock.mock.calls[0][0];
    const systemPrompt: string =
      typeof sysRaw === 'string'
        ? sysRaw
        : (sysRaw as Array<{ text: string }>).map((b) => b.text).join('\n');
    expect(systemPrompt).not.toContain('【事实包');
  });

  it('does NOT inject block when evidencePack is v1 (debate path)', async () => {
    const v1Pack = {
      schemaVersion: 'evidence-pack-v1' as const,
      symbol: '600519.SS',
      market: 'CN',
      capturedAt: '2026-05-14T00:00:00.000Z',
      // v1 has its own shape; we only check schemaVersion routing here.
    };
    const provider = fakeProvider({ chunks: [{ type: 'text', text: '# r' }] });
    await collect(
      streamDimension(provider, FUNDAMENTAL, minimalInput, {
        runId,
        todayDate: '2026-05-10',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        evidencePack: v1Pack as any,
      }),
    );
    const streamMock = provider.stream as unknown as ReturnType<typeof vi.fn>;
    // RFC-04: provider.stream now receives SystemTextBlock[] (cache enabled
    // by default) — flatten to a single string for assertion compatibility.
    const sysRaw = streamMock.mock.calls[0][0];
    const systemPrompt: string =
      typeof sysRaw === 'string'
        ? sysRaw
        : (sysRaw as Array<{ text: string }>).map((b) => b.text).join('\n');
    expect(systemPrompt).not.toContain('【事实包');
  });
});
