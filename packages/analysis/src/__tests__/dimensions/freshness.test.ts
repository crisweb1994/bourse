import { describe, expect, it } from 'vitest';
import {
  buildCommonSuffix,
  buildFreshnessBlock,
  DEFAULT_FRESHNESS,
} from '../../dimensions/freshness';

const FIXED_DATE = '2026-05-10';

describe('dimensions/buildFreshnessBlock', () => {
  it('injects todayDate into the preamble', () => {
    const block = buildFreshnessBlock(DEFAULT_FRESHNESS, FIXED_DATE);
    expect(block).toContain(`今日日期：${FIXED_DATE}`);
  });

  it('webSearchAvailable=false swaps to no-tool variant', () => {
    const block = buildFreshnessBlock(DEFAULT_FRESHNESS, FIXED_DATE, false);
    expect(block).toContain('本次运行无 web_search 工具可用');
    expect(block).toContain('<function>');
    expect(block).toContain('严禁');
    expect(block).not.toContain('必须使用 web_search 工具检索');
  });

  it('renders policy values (prices / news / financials / stale threshold)', () => {
    const block = buildFreshnessBlock(DEFAULT_FRESHNESS, FIXED_DATE);
    expect(block).toContain('使用最近 7 天内的报价');
    expect(block).toContain('使用最近 30 天内的报道');
    expect(block).toContain('使用最近一份已公布的季报或年报');
    expect(block).toContain('6 个月前或更早');
  });

  it('reproduces apps/api FRESHNESS_BLOCK byte-for-byte (parity gate)', () => {
    // Mirrors apps/api/src/ai/prompts/prompt.registry.ts:7-17 exactly.
    const expected = `
## 数据时效（最高优先级，必须严格遵守）
- 今日日期：${FIXED_DATE}（动态注入；以下所有"最新"均以此为基准）
- 你必须使用 web_search 工具检索数据，**严禁基于训练记忆给出任何具体数字**
- 财务数据：使用最近一份已公布的季报或年报；每个数据点必须标注「数据日期：YYYY-MM-DD」
- 股价/技术指标：必须使用最近 7 天内的报价
- 新闻/动态：必须使用最近 30 天内的报道
- 如果搜索仅能返回 6 个月前或更早的数据，请在报告**开头**写明「⚠️ 数据陈旧告警：最新可用数据为 YYYY-MM，可能不反映当前情况」，再继续基于这些数据分析
- 引用必须来自真实可访问的 URL，禁止编造链接
- 数字的内部一致性必须自查（如净利润不可大于收入；EPS × 流通股数 ≈ 净利润）
`;
    expect(buildFreshnessBlock(DEFAULT_FRESHNESS, FIXED_DATE)).toBe(expected);
  });
});

describe('dimensions/buildCommonSuffix', () => {
  it('contains the freshness block plus output requirements', () => {
    const suffix = buildCommonSuffix(DEFAULT_FRESHNESS, FIXED_DATE);
    expect(suffix).toContain('## 数据时效');
    expect(suffix).toContain('## 输出要求');
    expect(suffix).toContain('使用中文撰写报告');
  });

  it('forces the fixed disclaimer text (LLM cannot override)', () => {
    const suffix = buildCommonSuffix(DEFAULT_FRESHNESS, FIXED_DATE);
    expect(suffix).toContain(
      '免责声明：本报告由 AI 生成，不构成投资建议。投资有风险，入市需谨慎。',
    );
  });

  it('reproduces apps/api COMMON_SUFFIX byte-for-byte (parity gate)', () => {
    const expected = `\n${buildFreshnessBlock(DEFAULT_FRESHNESS, FIXED_DATE)}\n\n## 输出要求\n- 使用中文撰写报告\n- 每个核心判断必须附带引用来源 URL\n- 明确标注"数据截至日期"\n- 结尾声明"免责声明：本报告由 AI 生成，不构成投资建议。投资有风险，入市需谨慎。"\n- 数据缺失时诚实报告，不编造数据\n`;
    expect(buildCommonSuffix(DEFAULT_FRESHNESS, FIXED_DATE)).toBe(expected);
  });
});
