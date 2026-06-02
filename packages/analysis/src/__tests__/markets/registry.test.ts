import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearMarketRegistry,
  detectMarket,
  getMarket,
  HK,
  listMarkets,
  loadDefaultMarkets,
  registerMarket,
  US,
} from '../../markets';
import type { MarketProfile } from '../../markets';

describe('markets/registry', () => {
  beforeEach(() => clearMarketRegistry());
  afterEach(() => {
    clearMarketRegistry();
    loadDefaultMarkets();
  });

  it('register + getMarket round-trip (case-insensitive code)', () => {
    registerMarket(US);
    expect(getMarket('US')).toBe(US);
    expect(getMarket('us')).toBe(US);
  });

  it('listMarkets returns codes uppercased', () => {
    registerMarket(US);
    registerMarket(HK);
    expect(listMarkets().sort()).toEqual(['HK', 'US']);
  });

  it('returns undefined for unknown code', () => {
    expect(getMarket('SG')).toBeUndefined();
  });

  it('detectMarket finds the right profile by symbol shape', () => {
    loadDefaultMarkets();
    expect(detectMarket('AAPL')?.code).toBe('US');
    expect(detectMarket('0700.HK')?.code).toBe('HK');
    expect(detectMarket('600519.SS')?.code).toBe('CN');
    expect(detectMarket('7203.T')?.code).toBe('JP');
    expect(detectMarket('BARC.L')?.code).toBe('UK');
  });

  it('detectMarket returns undefined when no profile claims', () => {
    loadDefaultMarkets();
    expect(detectMarket('????.XX')).toBeUndefined();
  });

  it('registerMarket can be replaced', () => {
    const fakeUs: MarketProfile = {
      ...US,
      displayCurrency: 'XYZ',
    };
    registerMarket(US);
    registerMarket(fakeUs);
    expect(getMarket('US')?.displayCurrency).toBe('XYZ');
  });
});
