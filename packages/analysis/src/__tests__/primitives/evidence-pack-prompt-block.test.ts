import { describe, expect, it } from 'vitest';
import { formatEvidencePackBlock, buildStructuredOutputPrompts } from '../../primitives/dimension-prompts';
import type { EvidencePackV2 } from '../../contracts/evidence-pack-v2';

const pack = {
  schemaVersion: 'evidence-pack-v2',
  symbol: '9988.HK',
  market: 'HK',
  capturedAt: '2026-01-15T10:00:00.000Z',
  facts: {
    quote: {
      value: 80,
      asOf: '2026-01-15T09:00:00.000Z',
      retrievedAt: '2026-01-15T10:00:00.000Z',
      sourceUrl: 'https://example.com/quote',
      sourceTier: 'B',
    },
  },
  dataAvailability: {
    complete: ['quote'],
    missing: [{ field: 'financials', reason: 'no_data' }],
    fallbacks: [],
  },
  citations: [],
  trace: { toolCalls: 1, durationMs: 10, costUsd: 0 },
} as unknown as EvidencePackV2;

describe('evidence pack prompt V2', () => {
  it('shows verified facts, missing data and no-recalculation rule', () => {
    const text = formatEvidencePackBlock(pack, 'VALUATION_SCENARIOS');
    expect(text).toContain('代码核验事实');
    expect(text).toContain('quote');
    expect(text).toContain('数据缺失');
    expect(text).toContain('financials');
    expect(text).toContain('不得凭常识补齐');
  });

  it('describes the fixed structured output contract', () => {
    const prompts = buildStructuredOutputPrompts('RISK_REGISTER', 'report', []);
    expect(prompts.system).toContain('analysis-section-v2');
    expect(prompts.system).toContain('basedOnIncompleteSections');
    expect(prompts.system).toContain('没有缺失模块时填写 []');
    expect(prompts.system).toContain('数据缺口说明只能写入 limitations');
    expect(prompts.system).toContain('invalidates 都只能是字符串数组');
    expect(prompts.user).toContain('RISK_REGISTER');
  });
});
