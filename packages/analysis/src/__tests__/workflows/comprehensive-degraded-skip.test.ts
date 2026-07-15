/**
 * RFC rfc-evidence-pack-web-search-fallback §2.4: when the resolved pack is
 * critically degraded (missing `financials`), the workflow rebuilds via the v1
 * web_search builder — unconditionally, since with no fundamentals there is
 * nothing else to analyze. Dims whose `requiresPrivateData` overlaps the pack's
 * `missingPrivateFields` are then SKIPPED (not run on incomplete data).
 *
 * Path A is the only structured-pack source in production (apps/api pre-builds
 * the pack via connector → compute + CN tool signals), so these tests drive
 * the skip behavior by passing a critically-degraded `options.evidencePack`
 * directly rather than through the (now-deleted) internal Stage-0 builder.
 *
 * Isolated in its own file because the v1 builder mock would interfere with
 * comprehensive.test.ts happy-path expectations.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EvidencePack } from '../../contracts/evidence-pack';
import type {
  AgentProvider,
  ProviderStreamResult,
} from '../../primitives/provider';

vi.mock('../../primitives/evidence-pack-builder', () => ({
  buildEvidencePack: vi.fn(),
}));

import { buildEvidencePack } from '../../primitives/evidence-pack-builder';
import { getDimension } from '../../dimensions';
const GOVERNANCE = getDimension('GOVERNANCE');
const SENTIMENT = getDimension('SENTIMENT');
const VALUATION = getDimension('VALUATION');
import { streamComprehensive } from '../../workflows/comprehensive';

const TODAY = '2026-05-19';
const runId = 'r-degraded';
const minimalInput = {
  symbol: '600519.SS',
  market: 'CN',
  locale: 'zh-CN' as const,
};

function buildPackWithMissing(
  missing: Array<'northboundFlow' | 'lhb' | 'unlockCalendar' | 'consensusEps'>,
): EvidencePack {
  return {
    schemaVersion: 'evidence-pack-v1',
    symbol: '600519.SS',
    market: 'CN',
    capturedAt: '2026-05-19T00:00:00.000Z',
    financialSnapshot: { price: 100 },
    news: [],
    valuation: {},
    riskFacts: [],
    allowedUrls: [],
    dataAvailability: {
      degradedSource: 'WEB_SEARCH_FALLBACK',
      missingPrivateFields: missing,
    },
  };
}

// Minimal snapshot/v2-shaped pack (Path A). `complete` drives the
// critically-degraded check (no quote + no financials → degraded).
function buildV2Pack(complete: string[]): any {
  return {
    schemaVersion: 'evidence-pack-v2',
    symbol: '600519.SS',
    market: 'CN',
    facts: {},
    computedFacts: {},
    dataAvailability: { complete, missing: [] },
    citations: [],
  };
}

/**
 * Provider that returns a valid dim payload for any stream call. We
 * never expect SENTIMENT / GOVERNANCE / VALUATION to be invoked when
 * skip fires; the test asserts only the *non-skipped* dims hit it.
 */
function buildProvider(streamCalls: string[]): AgentProvider {
  return {
    name: 'fake',
    stream: vi.fn(
      async (_sysRaw, _user, onChunk): Promise<ProviderStreamResult> => {
        streamCalls.push('stream');
        const text = '# section body';
        onChunk({ type: 'text', text });
        return {
          text,
          citations: [],
          usage: { tokensIn: 50, tokensOut: 25 },
          toolUseCounts: {},
          model: 'fake',
        };
      },
    ),
    complete: vi.fn(async () => ({
      text: JSON.stringify({
        schemaVersion: 'analysis-result-v1',
        conclusion: {
          signal: 'NEUTRAL',
          confidence: 'LOW',
          oneLiner: 'x',
          evidence: [],
        },
        evidence: [],
        dataAvailability: { missingFields: [], reason: '' },
        dataAsOf: TODAY,
        disclaimer: 'd',
      }),
      usage: { tokensIn: 0, tokensOut: 0 },
      model: 'fake',
    })),
    getModel: () => 'fake',
    getUtilityModel: () => 'fake',
  };
}

async function collect(
  gen: AsyncGenerator<unknown, unknown, undefined>,
): Promise<{ events: any[]; result: any }> {
  const events: any[] = [];
  let r = await gen.next();
  while (!r.done) {
    events.push(r.value);
    r = await gen.next();
  }
  return { events, result: r.value };
}

describe('streamComprehensive — skip dims on degraded pack', () => {
  beforeEach(() => {
    vi.mocked(buildEvidencePack).mockReset();
  });

  it('Dimensions have the expected requiresPrivateData contract', () => {
    expect(SENTIMENT.requiresPrivateData).toEqual(['northboundFlow', 'lhb']);
    expect(GOVERNANCE.requiresPrivateData).toEqual(['unlockCalendar']);
    expect(VALUATION.requiresPrivateData).toEqual(['consensusEps']);
  });

  it('Path A: a passed evidencePack is used directly — no v1 fallback, no skip', async () => {
    const pack = buildV2Pack(['quote', 'financials', 'history']);
    const streamCalls: string[] = [];
    const { events } = await collect(
      streamComprehensive(buildProvider(streamCalls), minimalInput, {
        runId,
        todayDate: TODAY,
        evidencePack: pack,
        recoverMissingEvidence: true,
      }),
    );
    expect(vi.mocked(buildEvidencePack)).not.toHaveBeenCalled();
    const ready = events.find((e) => e.type === 'evidence_pack_ready');
    expect(ready?.pack).toBe(pack);
    expect(events.filter((e) => e.type === 'section_skipped')).toHaveLength(0);
  });

  it('Path A: pack with quote but no financials → NO whole-pack recovery (V2 kept; gaps go to gap-fill)', async () => {
    // Partial degradation is NOT critical: quote/history/computedFacts are kept,
    // missing financials is filled per-field by each dim's gap-fill — we never
    // discard the V2 pack just because financials is absent.
    const partial = buildV2Pack(['quote', 'history']); // has quote, NO financials
    const streamCalls: string[] = [];
    const { events } = await collect(
      streamComprehensive(buildProvider(streamCalls), minimalInput, {
        runId,
        todayDate: TODAY,
        evidencePack: partial,
        recoverMissingEvidence: true,
      }),
    );
    expect(vi.mocked(buildEvidencePack)).not.toHaveBeenCalled();
    const ready = events.find((e) => e.type === 'evidence_pack_ready');
    expect(ready?.pack).toBe(partial);
    expect(events.filter((e) => e.type === 'section_skipped')).toHaveLength(0);
  });

  it('Path A: critically-degraded pack → v1 fallback → SENTIMENT / GOVERNANCE / VALUATION skipped', async () => {
    // A degraded Path-A pack (no financials) triggers the v1 web_search rebuild.
    // With no per-tool failure info, the workflow marks all 4 private fields
    // missing (inferMissingPrivateFieldsComp([])), so every dim that declares
    // requiresPrivateData is skipped.
    const degraded = buildV2Pack([]);
    vi.mocked(buildEvidencePack).mockResolvedValueOnce(
      buildPackWithMissing([
        'northboundFlow',
        'lhb',
        'unlockCalendar',
        'consensusEps',
      ]),
    );

    const streamCalls: string[] = [];
    const { events } = await collect(
      streamComprehensive(buildProvider(streamCalls), minimalInput, {
        runId,
        todayDate: TODAY,
        evidencePack: degraded,
        recoverMissingEvidence: true,
      }),
    );

    expect(vi.mocked(buildEvidencePack)).toHaveBeenCalledTimes(1);
    const skipped = events.filter((e) => e.type === 'section_skipped');
    const skippedTypes = skipped.map((e) => e.sectionType).sort();
    expect(skippedTypes).toEqual(['GOVERNANCE', 'SENTIMENT', 'VALUATION']);
    for (const e of skipped) {
      expect(e.reason).toBe('DEGRADED_SOURCE_MISSING_PRIVATE_DATA');
      expect(e.missingFields.length).toBeGreaterThan(0);
    }
  });

  it('Path A: non-degraded pack (has financials) → no v1 fallback, no skip (even with recovery enabled)', async () => {
    const pack = buildV2Pack(['quote', 'financials']);
    const streamCalls: string[] = [];
    const { events } = await collect(
      streamComprehensive(buildProvider(streamCalls), minimalInput, {
        runId,
        todayDate: TODAY,
        evidencePack: pack,
        recoverMissingEvidence: true,
      }),
    );

    expect(vi.mocked(buildEvidencePack)).not.toHaveBeenCalled();
    expect(events.filter((e) => e.type === 'section_skipped')).toHaveLength(0);
  });
});
