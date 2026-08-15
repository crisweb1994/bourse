import { describe, expect, it } from 'vitest';
import { AnalysisRequest } from '../../contracts/analysis-request';

const base = {
  symbol: '9988.HK',
  market: 'HK',
  mode: 'QUICK' as const,
};

describe('AnalysisRequest V2', () => {
  it('applies the stable locale and focus-window defaults', () => {
    expect(AnalysisRequest.parse(base)).toMatchObject({
      mode: 'QUICK',
      focusWindow: '90D',
      locale: 'zh-CN',
    });
  });

  it('accepts only the supported modes and windows', () => {
    expect(AnalysisRequest.parse({ ...base, mode: 'DEEP', focusWindow: '3Y' })).toMatchObject({
      mode: 'DEEP',
      focusWindow: '3Y',
    });
    expect(() => AnalysisRequest.parse({ ...base, mode: 'COMPREHENSIVE' })).toThrow();
    expect(() => AnalysisRequest.parse({ ...base, focusWindow: 'CUSTOM' })).toThrow();
  });

  it('trims an optional question and enforces its size', () => {
    expect(AnalysisRequest.parse({ ...base, question: '  毛利率会恢复吗？  ' }).question)
      .toBe('毛利率会恢复吗？');
    expect(() => AnalysisRequest.parse({ ...base, question: '   ' })).toThrow();
    expect(() => AnalysisRequest.parse({ ...base, question: 'a'.repeat(501) })).toThrow();
  });
});
