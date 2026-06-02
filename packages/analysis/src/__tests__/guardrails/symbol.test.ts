import { describe, expect, it } from 'vitest';
import { enforceSymbol } from '../../guardrails/symbol';
import { InvalidSymbolError } from '../../primitives/errors';

describe('guardrails/enforceSymbol — explicit market hint', () => {
  it('normalizes lowercase US symbols', () => {
    const r = enforceSymbol('aapl', 'US');
    expect(r.normalized).toBe('AAPL');
    expect(r.market.code).toBe('US');
  });

  it('pads HK leading zeros', () => {
    const r = enforceSymbol('700', 'HK');
    expect(r.normalized).toBe('0700.HK');
    expect(r.providerSymbols.bloomberg).toBe('700 HK Equity');
  });

  it('infers CN suffix from leading digits', () => {
    expect(enforceSymbol('600519', 'CN').normalized).toBe('600519.SS');
    expect(enforceSymbol('000858', 'CN').normalized).toBe('000858.SZ');
  });

  it('case-insensitive market hint', () => {
    expect(enforceSymbol('AAPL', 'us').market.code).toBe('US');
  });

  it('throws InvalidSymbolError on unknown market', () => {
    expect(() => enforceSymbol('AAPL', 'XX')).toThrow(InvalidSymbolError);
  });

  it('throws InvalidSymbolError when symbol fails market validation', () => {
    expect(() => enforceSymbol('@@@', 'US')).toThrow(InvalidSymbolError);
  });

  it('throws InvalidSymbolError on empty symbol', () => {
    expect(() => enforceSymbol('   ', 'US')).toThrow(InvalidSymbolError);
  });
});

describe('guardrails/enforceSymbol — auto-detect', () => {
  it('detects US for AAPL', () => {
    expect(enforceSymbol('AAPL').market.code).toBe('US');
  });

  it('detects HK for 0700.HK', () => {
    expect(enforceSymbol('0700.HK').market.code).toBe('HK');
  });

  it('throws when no market claims the symbol', () => {
    expect(() => enforceSymbol('????.XX')).toThrow(InvalidSymbolError);
  });
});
