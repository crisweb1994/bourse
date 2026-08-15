import { describe, expect, it } from 'vitest';
import { ALL_DIMENSIONS } from '../../dimensions';
import { runComprehensive } from '../../workflows/comprehensive';
import type { AgentProvider } from '../../primitives/provider';

function provider(): AgentProvider {
  return {
    name: 'fake',
    stream: async () => ({ text: 'report', citations: [], usage: { tokensIn: 1, tokensOut: 1 } }),
    complete: async (system, user) => {
      // The summary prompt is now identified by its stable system role. The
      // user prompt intentionally contains only completed module reports.
      const systemText = typeof system === 'string'
        ? system
        : system.map((block) => block.text).join('\n');
      if (systemText.includes('综合研究结论整理器')) {
        return {
          text: JSON.stringify({
            headline: 'headline',
            signal: 'NEUTRAL',
            confidence: 'MEDIUM',
            rationale: [],
            counterpoints: [],
            changeConditions: [],
            missingSections: [],
            dataAsOf: '2026-01-15',
            disclaimer: 'D',
          }),
          usage: { tokensIn: 1, tokensOut: 1 },
        };
      }
      const type = ALL_DIMENSIONS.find((dimension) => user.includes(dimension.type))?.type ??
        (user.includes('行业与竞争') ? 'INDUSTRY_POSITION' :
          user.includes('估值与情景') ? 'VALUATION_SCENARIOS' :
            user.includes('市场信号') ? 'MARKET_SIGNALS' :
              user.includes('风险清单') ? 'RISK_REGISTER' : 'COMPANY_QUALITY');
      return {
        text: JSON.stringify({
          schemaVersion: 'analysis-section-v2', type,
          assessment: type === 'RISK_REGISTER' ? 'MEDIUM' :
            type === 'COMPANY_QUALITY' ? 'MIXED' :
              type === 'INDUSTRY_POSITION' ? 'COMPETITIVE' :
                type === 'VALUATION_SCENARIOS' ? 'FAIR' : 'NEUTRAL',
          confidence: 'MEDIUM', summary: 'summary', findings: [], limitations: [], dataAsOf: '2026-01-15', disclaimer: 'D',
        }),
        usage: { tokensIn: 1, tokensOut: 1 },
      };
    },
    getModel: () => 'm',
    getUtilityModel: () => 'u',
  };
}

describe('workflow wave semantics V2', () => {
  it('supports sequential execution for deterministic tests and constrained deployments', async () => {
    const result = await runComprehensive(provider(), { symbol: 'AAPL', market: 'US', locale: 'zh-CN' }, {
      runId: 'sequential', mode: 'DEEP', waveMode: 'sequential', waveSemaphore: 1,
    });
    expect(result.status).toBe('COMPLETED');
    expect(result.perDimension.size).toBe(5);
  });
});
