import { describe, expect, it } from 'vitest';
import { ALL_DIMENSIONS } from '../../dimensions';
import { runComprehensive } from '../../workflows/comprehensive';
import type { AgentProvider } from '../../primitives/provider';

const input = { symbol: 'AAPL', market: 'US', locale: 'zh-CN' };

function provider(): AgentProvider {
  return {
    name: 'fake',
    stream: async () => ({ text: 'report', citations: [], usage: { tokensIn: 1, tokensOut: 1 } }),
    complete: async (_system, user) => {
      const type = user.includes('风险清单') ? 'RISK_REGISTER' : 'COMPANY_QUALITY';
      return {
        text: JSON.stringify({
          schemaVersion: 'analysis-section-v2', type, assessment: type === 'RISK_REGISTER' ? 'MEDIUM' : 'MIXED',
          confidence: 'LOW', summary: 'summary', findings: [], limitations: [], dataAsOf: '2026-01-15', disclaimer: 'D',
        }),
        usage: { tokensIn: 1, tokensOut: 1 },
      };
    },
    getModel: () => 'm',
    getUtilityModel: () => 'u',
  };
}

describe('coverage skip semantics V2', () => {
  it('emits a controlled skip instead of invoking the provider', async () => {
    const market = ALL_DIMENSIONS.find((dimension) => dimension.type === 'MARKET_SIGNALS')!;
    const result = await runComprehensive(provider(), input, {
      runId: 'skip-test', dimensions: [market], evidencePack: {
        schemaVersion: 'evidence-pack-v2',
        researchCoverage: { dimensions: { MARKET_SIGNALS: { skip: true, missingCriticalFacts: ['quote', 'history'] } } },
      } as never,
    });
    expect(result.status).toBe('FAILED');
    expect(result.skippedDimensions).toContain('MARKET_SIGNALS');
  });
});
