import { describe, expect, it } from 'vitest';
import {
  formatInstrumentId,
  isInstrumentIdFormat,
  parseInstrumentId,
  parseYahooSymbol,
} from './instrument-id';

describe('parseInstrumentId', () => {
  it('parses canonical forms across supported markets', () => {
    expect(parseInstrumentId('US:NVDA')).toEqual({ market: 'US', symbol: 'NVDA', raw: 'US:NVDA' });
    expect(parseInstrumentId('CN:600519')).toEqual({ market: 'CN', symbol: '600519', raw: 'CN:600519' });
    expect(parseInstrumentId('HK:00700')).toEqual({ market: 'HK', symbol: '00700', raw: 'HK:00700' });
    expect(parseInstrumentId('JP:7203')).toEqual({ market: 'JP', symbol: '7203', raw: 'JP:7203' });
    expect(parseInstrumentId('UK:BARC')).toEqual({ market: 'UK', symbol: 'BARC', raw: 'UK:BARC' });
  });

  it('normalizes market case but preserves symbol case', () => {
    expect(parseInstrumentId('us:NVDA')).toEqual({ market: 'US', symbol: 'NVDA', raw: 'US:NVDA' });
    expect(parseInstrumentId('us:nvda')).toEqual({ market: 'US', symbol: 'nvda', raw: 'US:nvda' });
  });

  it('tolerates surrounding whitespace', () => {
    expect(parseInstrumentId('  US:NVDA  ')).toEqual({ market: 'US', symbol: 'NVDA', raw: 'US:NVDA' });
  });

  it('rejects unknown markets', () => {
    expect(parseInstrumentId('DE:SAP')).toBeNull();
    expect(parseInstrumentId('XX:NVDA')).toBeNull();
  });

  it('rejects malformed input', () => {
    expect(parseInstrumentId('')).toBeNull();
    expect(parseInstrumentId('NVDA')).toBeNull();
    expect(parseInstrumentId('US:')).toBeNull();
    expect(parseInstrumentId(':NVDA')).toBeNull();
    expect(parseInstrumentId('US-NVDA')).toBeNull();
    expect(parseInstrumentId('US:NV DA')).toBeNull();
  });

  it('rejects non-string input safely', () => {
    expect(parseInstrumentId(undefined)).toBeNull();
    expect(parseInstrumentId(null)).toBeNull();
    expect(parseInstrumentId(123)).toBeNull();
    expect(parseInstrumentId({})).toBeNull();
  });
});

describe('isInstrumentIdFormat', () => {
  it('strict — no normalization', () => {
    expect(isInstrumentIdFormat('US:NVDA')).toBe(true);
    expect(isInstrumentIdFormat('us:NVDA')).toBe(false);
    expect(isInstrumentIdFormat(' US:NVDA ')).toBe(false);
    expect(isInstrumentIdFormat('NVDA')).toBe(false);
  });
});

describe('formatInstrumentId', () => {
  it('concatenates canonical form', () => {
    expect(formatInstrumentId('US', 'NVDA')).toBe('US:NVDA');
    expect(formatInstrumentId('HK', '00700')).toBe('HK:00700');
  });

  it('trims symbol but throws on empty', () => {
    expect(formatInstrumentId('US', '  NVDA  ')).toBe('US:NVDA');
    expect(() => formatInstrumentId('US', '')).toThrow();
    expect(() => formatInstrumentId('US', '   ')).toThrow();
  });
});

describe('parseYahooSymbol', () => {
  it('maps known suffixes to market codes', () => {
    // HK is padded to canonical 5-digit
    expect(parseYahooSymbol('0700.HK')).toEqual({ market: 'HK', symbol: '00700', source: 'yahoo-suffix' });
    expect(parseYahooSymbol('600519.SS')).toEqual({ market: 'CN', symbol: '600519', source: 'yahoo-suffix' });
    expect(parseYahooSymbol('000001.SZ')).toEqual({ market: 'CN', symbol: '000001', source: 'yahoo-suffix' });
    expect(parseYahooSymbol('7203.T')).toEqual({ market: 'JP', symbol: '7203', source: 'yahoo-suffix' });
    expect(parseYahooSymbol('BARC.L')).toEqual({ market: 'UK', symbol: 'BARC', source: 'yahoo-suffix' });
  });

  it('is case-insensitive on suffix (HK still padded to 5-digit canonical)', () => {
    expect(parseYahooSymbol('0700.hk')).toEqual({ market: 'HK', symbol: '00700', source: 'yahoo-suffix' });
  });

  it('rejects bare symbols without suffix — never guesses US', () => {
    expect(parseYahooSymbol('NVDA')).toBeNull();
    expect(parseYahooSymbol('AAPL')).toBeNull();
  });

  it('rejects unknown suffixes', () => {
    expect(parseYahooSymbol('FOO.BAR')).toBeNull();
    expect(parseYahooSymbol('FOO.DE')).toBeNull();
  });

  it('rejects malformed input', () => {
    expect(parseYahooSymbol('.HK')).toBeNull();
    expect(parseYahooSymbol('0700.')).toBeNull();
    expect(parseYahooSymbol('')).toBeNull();
    expect(parseYahooSymbol(undefined)).toBeNull();
  });
});
