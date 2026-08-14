import { describe, expect, it } from 'vitest';
import { getDimension, listDimensions } from '../../dimensions/registry';

describe('dimension registry V2', () => {
  it('looks up only the five fixed section types', () => {
    expect(listDimensions()).toEqual([
      'COMPANY_QUALITY', 'INDUSTRY_POSITION', 'VALUATION_SCENARIOS',
      'RISK_REGISTER', 'MARKET_SIGNALS',
    ]);
    expect(getDimension('COMPANY_QUALITY').type).toBe('COMPANY_QUALITY');
    expect(() => getDimension('FUNDAMENTAL' as never)).toThrow();
  });

  it('keeps the user question as focus instead of replacing the module prompt', () => {
    const prompt = getDimension('COMPANY_QUALITY').buildPrompts(
      { symbol: 'AAPL', market: 'US', locale: 'zh-CN', question: '毛利率会恢复吗？' },
      { todayDate: '2026-01-15' },
    );
    expect(prompt.user).toContain('公司质量');
    expect(prompt.user).toContain('毛利率会恢复吗？');
    expect(prompt.user).toContain('不得改变');
  });
});
