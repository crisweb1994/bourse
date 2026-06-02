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

  it('rejects empty symbol', () => {
    expect(() => AnalysisRequest.parse({ ...minimal, symbol: '' })).toThrow();
  });

  it('rejects unknown analysis type', () => {
    expect(() =>
      AnalysisRequest.parse({ ...minimal, type: 'NOT_A_TYPE' }),
    ).toThrow();
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
