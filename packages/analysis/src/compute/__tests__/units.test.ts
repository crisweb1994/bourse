import { describe, expect, it } from 'vitest';
import {
  currencyForMarket,
  normalize,
  normalizeCurrency,
  unitMultiplier,
} from '../units';

describe('compute/units · unitMultiplier', () => {
  it('recognizes base currency units as 1', () => {
    expect(unitMultiplier('USD')).toBe(1);
    expect(unitMultiplier('usd')).toBe(1);
    expect(unitMultiplier('CNY')).toBe(1);
    expect(unitMultiplier('元')).toBe(1);
    expect(unitMultiplier('HKD')).toBe(1);
    expect(unitMultiplier('人民币元')).toBe(1);
  });

  it('scales CN 万元 to 10,000', () => {
    expect(unitMultiplier('万元')).toBe(10_000);
    expect(unitMultiplier('万')).toBe(10_000);
  });

  it('scales CN 亿元 to 100,000,000', () => {
    expect(unitMultiplier('亿元')).toBe(100_000_000);
    expect(unitMultiplier('亿')).toBe(100_000_000);
  });

  it('scales English aliases (thousands / millions / billions)', () => {
    expect(unitMultiplier('thousands')).toBe(1_000);
    expect(unitMultiplier('millions')).toBe(1_000_000);
    expect(unitMultiplier('billions')).toBe(1_000_000_000);
    expect(unitMultiplier('K')).toBe(1_000);
    expect(unitMultiplier('M')).toBe(1_000_000);
    expect(unitMultiplier('Bn')).toBe(1_000_000_000);
  });

  it('passes through per-share and ratio units as 1', () => {
    expect(unitMultiplier('USD/shares')).toBe(1);
    expect(unitMultiplier('shares')).toBe(1);
    expect(unitMultiplier('pure')).toBe(1);
    expect(unitMultiplier('ratio')).toBe(1);
    expect(unitMultiplier('percent')).toBe(1);
  });

  it('returns null for unknown units', () => {
    expect(unitMultiplier('weeks')).toBeNull();
    expect(unitMultiplier('squirrels')).toBeNull();
    expect(unitMultiplier('')).toBeNull();
  });
});

describe('compute/units · normalize', () => {
  it('scales 万元 values correctly (the CN bug data.md flagged)', () => {
    const result = normalize(1_234.5, '万元', 'revenue');
    expect(result.value).toBe(12_345_000);
    expect(result.warning).toBeNull();
  });

  it('passes through base USD values unchanged', () => {
    const result = normalize(394_328_000_000, 'USD', 'revenue');
    expect(result.value).toBe(394_328_000_000);
    expect(result.warning).toBeNull();
  });

  it('handles null / undefined / NaN as null without warning', () => {
    expect(normalize(null, 'USD', 'revenue').value).toBeNull();
    expect(normalize(undefined, 'USD', 'revenue').value).toBeNull();
    expect(normalize(NaN, 'USD', 'revenue').value).toBeNull();
    expect(normalize(null, 'USD', 'revenue').warning).toBeNull();
  });

  it('surfaces unknown_unit warning when unit is unrecognized', () => {
    const result = normalize(100, 'parsec', 'distance');
    expect(result.value).toBeNull();
    expect(result.warning).toEqual({
      code: 'unknown_unit',
      metric: 'distance',
      detail: expect.stringContaining('parsec'),
    });
  });

  it('preserves precision for large 亿元 values (Eastmoney edge)', () => {
    // 茅台 2024 营收 ~ 1741 亿元
    const result = normalize(1741.4, '亿元', 'revenue');
    expect(result.value).toBe(174_140_000_000);
  });
});

describe('compute/units · normalizeCurrency', () => {
  it('canonicalizes common aliases', () => {
    expect(normalizeCurrency('USD')).toBe('USD');
    expect(normalizeCurrency('usd')).toBe('USD');
    expect(normalizeCurrency('CNY')).toBe('CNY');
    expect(normalizeCurrency('RMB')).toBe('CNY');
    expect(normalizeCurrency('HKD')).toBe('HKD');
  });

  it('returns null for unknown currencies (force caller to handle)', () => {
    expect(normalizeCurrency('EUR')).toBeNull();
    expect(normalizeCurrency('JPY')).toBeNull();
  });
});

describe('compute/units · currencyForMarket', () => {
  it('maps markets to canonical currency', () => {
    expect(currencyForMarket('US')).toBe('USD');
    expect(currencyForMarket('us')).toBe('USD');
    expect(currencyForMarket('CN')).toBe('CNY');
    expect(currencyForMarket('HK')).toBe('HKD');
  });

  it('defaults to USD for unknown markets', () => {
    expect(currencyForMarket('XX')).toBe('USD');
  });
});
