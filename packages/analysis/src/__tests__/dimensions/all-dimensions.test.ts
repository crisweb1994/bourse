import { describe, expect, it } from 'vitest';
import { StructuredJson } from '../../contracts/analysis-result';
import { ALL_DIMENSIONS } from '../../dimensions';
import { DEFAULT_FRESHNESS } from '../../dimensions/freshness';
// refactor-v1 Wave 5: registerDimension/clearRegistry 已删；ALL_DIMENSIONS 静态。

const EXPECTED_TYPES = [
  'FUNDAMENTAL',
  'GOVERNANCE',
  'VALUATION',
  'INDUSTRY',
  'RISK',
  'TECHNICAL',
  'SENTIMENT',
  'SCENARIO',
  'PORTFOLIO',
] as const;

// Per-dimension prompt keywords lifted from apps/api prompt.registry.ts so
// any drift in our verbatim port is caught. GOVERNANCE is Plan 3-new — its
// keywords come from MVP doc §3.1 GOVERNANCE row.
const KEYWORDS_BY_TYPE: Record<(typeof EXPECTED_TYPES)[number], string[]> = {
  FUNDAMENTAL: ['基本面分析师', '商业模式', '财务趋势', '盈利质量', '护城河'],
  GOVERNANCE: ['公司治理分析师', '股权结构', '管理层激励', 'ROIC', '资本配置'],
  VALUATION: ['估值分析师', 'DCF', 'WACC', 'PE、PS、EV/EBITDA', '反向 DCF'],
  INDUSTRY: ['行业分析师', '行业概览', '竞争格局', '竞争地位'],
  RISK: ['风险分析师', '公司风险', '宏观风险', '监管/合规风险', '综合风险评级'],
  TECHNICAL: ['技术分析师', '趋势判断', '支撑位和阻力位', 'RSI、MACD'],
  SENTIMENT: ['市场情绪分析师', '分析师共识', '机构动向', '内部交易', '做空数据'],
  SCENARIO: ['情景分析师', '牛市情景', '基本情景', '熊市情景', '关键变量'],
  PORTFOLIO: ['投资组合顾问', '风险适配', '期限适配', '风格适配', '仓位建议', '分散化影响'],
};

describe('dimensions/ALL_DIMENSIONS — coverage', () => {
  it('exports exactly the 9 dimensions in canonical order', () => {
    expect(ALL_DIMENSIONS.map((d) => d.type)).toEqual([...EXPECTED_TYPES]);
  });

  it('every dimension shares walking-skeleton defaults', () => {
    for (const dim of ALL_DIMENSIONS) {
      expect(dim.allowedTools).toEqual(['webSearch']);
      expect(dim.outputSchema).toBe(StructuredJson);
      expect(dim.freshness).toBe(DEFAULT_FRESHNESS);
      expect(dim.onFailure).toBe('retry-once');
    }
  });

  it.each(EXPECTED_TYPES)(
    '%s system prompt contains expected keywords (verbatim parity)',
    (type) => {
      const dim = ALL_DIMENSIONS.find((d) => d.type === type);
      expect(dim).toBeDefined();
      const { system } = dim!.buildPrompts(
        { symbol: 'AAPL', market: 'US', locale: 'zh-CN' },
        { todayDate: '2026-05-10' },
      );
      for (const kw of KEYWORDS_BY_TYPE[type]) {
        expect(system).toContain(kw);
      }
    },
  );

  it.each(EXPECTED_TYPES)(
    '%s user prompt embeds symbol + market',
    (type) => {
      const dim = ALL_DIMENSIONS.find((d) => d.type === type)!;
      const { user } = dim.buildPrompts(
        { symbol: 'AAPL', market: 'US', name: '苹果', locale: 'zh-CN' },
        { todayDate: '2026-05-10' },
      );
      expect(user).toContain('AAPL');
      expect(user).toContain('US 市场');
      expect(user).toContain('苹果');
    },
  );
});

// refactor-v1 Wave 5: removed "registry round-trip" suite — DIMENSION_CONFIGS
// is now static; round-trip would just re-verify the array's own derivation.
// Lookup coverage moved to dimensions/registry.test.ts.
