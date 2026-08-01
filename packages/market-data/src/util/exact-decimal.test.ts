import { describe, expect, it } from 'vitest';
import { decimalSubtract } from './exact-decimal';

describe('decimalSubtract', () => {
  it('avoids IEEE754 drift', () => {
    expect(decimalSubtract('6.34', '5.1')).toBe('1.24');
  });

  it('aligns fractional scales', () => {
    expect(decimalSubtract('100', '0.01')).toBe('99.99');
    expect(decimalSubtract('0.01', '0.001')).toBe('0.009');
  });

  it('handles large integers beyond safe float display', () => {
    expect(decimalSubtract('1000000000000', '1')).toBe('999999999999');
  });

  it('handles negatives', () => {
    expect(decimalSubtract('-5', '3')).toBe('-8');
    expect(decimalSubtract('5', '-3')).toBe('8');
    expect(decimalSubtract('-5', '-3')).toBe('-2');
  });

  it('returns zero correctly', () => {
    expect(decimalSubtract('0', '0')).toBe('0');
    expect(decimalSubtract('7', '7')).toBe('0');
  });

  it('rejects malformed input', () => {
    expect(() => decimalSubtract('1e3', '1')).toThrow();
    expect(() => decimalSubtract('abc', '1')).toThrow();
  });
});
