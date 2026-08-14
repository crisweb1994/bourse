import { describe, expect, it } from 'vitest';
import type { EvidencePackV2 } from '../../contracts/evidence-pack-v2';
import { formatEvidencePackBlock } from '../../primitives/dimension-prompts';

function pack(computedFacts?: EvidencePackV2['computedFacts']): EvidencePackV2 {
  return {
    schemaVersion: 'evidence-pack-v2',
    symbol: 'AAPL',
    market: 'US',
    capturedAt: '2025-05-25T15:00:00.000Z',
    facts: {},
    dataAvailability: { complete: [], missing: [], fallbacks: [] },
    citations: [],
    trace: { durationMs: 0, toolCalls: 0, costUsd: 0 },
    ...(computedFacts ? { computedFacts } : {}),
  };
}

describe('dimension prompt computed facts', () => {
  it('does not add a compute block when no deterministic facts exist', () => {
    expect(formatEvidencePackBlock(pack())).not.toContain('代码计算指标');
  });

  it('passes deterministic ratios and technical indicators to the model as data', () => {
    const text = formatEvidencePackBlock(pack({
      ratios: { pe: 28.5 } as never,
      technical: { bars: 250, rsi14: 62.5 } as never,
      valuation: null,
      peerComparison: null,
      historicalContext: [],
      redFlags: [],
      warnings: [],
    }));
    expect(text).toContain('代码计算指标');
    expect(text).toContain('"pe": 28.5');
    expect(text).toContain('"rsi14": 62.5');
    expect(text).toContain('不能覆盖代码核验数字');
  });
});
