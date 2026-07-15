import { describe, expect, it } from 'vitest';
import { AnalysisRequest, Budget } from '../../contracts/analysis-request';

const minimal = {
  symbol: 'TEST',
  market: 'US',
  type: 'FUNDAMENTAL' as const,
};

describe('contracts/AnalysisRequest', () => {
  it('parses minimal request and applies default locale', () => {
    const parsed = AnalysisRequest.parse(minimal);
    expect(parsed.locale).toBe('zh-CN');
    expect(parsed.symbol).toBe('TEST');
  });

  it('accepts optional competitors / budget', () => {
    const full = {
      ...minimal,
      locale: 'en-US',
      competitors: ['MSFT', 'GOOG'],
      budget: { maxCostUsd: 0.5, maxToolCalls: 20 },
    };
    expect(AnalysisRequest.parse(full).budget?.maxCostUsd).toBe(0.5);
  });

  it('accepts and trims an optional research question', () => {
    const parsed = AnalysisRequest.parse({
      ...minimal,
      question: '  财报后的利润率能否恢复？  ',
    });
    expect(parsed.question).toBe('财报后的利润率能否恢复？');
  });

  it('rejects an empty or overlong research question', () => {
    expect(() =>
      AnalysisRequest.parse({ ...minimal, question: '   ' }),
    ).toThrow();
    expect(() =>
      AnalysisRequest.parse({ ...minimal, question: 'a'.repeat(501) }),
    ).toThrow();
  });

  it('rejects empty symbol', () => {
    expect(() => AnalysisRequest.parse({ ...minimal, symbol: '' })).toThrow();
  });

  it('rejects unknown analysis type', () => {
    expect(() =>
      AnalysisRequest.parse({ ...minimal, type: 'NOT_A_TYPE' }),
    ).toThrow();
  });

  it('rejects legacy analysis types for new run requests', () => {
    expect(() => AnalysisRequest.parse({ ...minimal, type: 'DEBATE' })).toThrow();
  });
});

describe('contracts/Budget', () => {
  it('all caps optional', () => {
    expect(Budget.parse({})).toEqual({});
  });

  it('rejects non-positive values', () => {
    expect(() => Budget.parse({ maxCostUsd: 0 })).toThrow();
    expect(() => Budget.parse({ maxToolCalls: -5 })).toThrow();
  });
});
