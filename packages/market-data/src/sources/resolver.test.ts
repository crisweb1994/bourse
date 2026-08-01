import { describe, expect, it } from 'vitest';
import { DefaultInstrumentResolver } from './resolver';

describe('DefaultInstrumentResolver', () => {
  const resolver = new DefaultInstrumentResolver();

  it.each([
    ['HK:0700', 'tencent-hk', 'hk00700'],
    ['HK:0700', 'yahoo', '0700.HK'],
    ['CN:600519', 'tencent-cn-history', 'sh600519'],
    ['CN:000001', 'cn-finance', '0.000001'],
    ['US:AAPL', 'eodhd', 'AAPL.US'],
    ['CN:600519', 'eodhd', '600519.SHG'],
    ['HK:0700', 'twelve-data', '0700:HKEX'],
    ['HK:0700', 'eastmoney-hk-financials', '00700.HK'],
  ])('maps %s for %s deterministically', (instrumentId, sourceId, providerSymbol) => {
    const resolved = resolver.resolve({ instrumentId, sourceId, capability: 'quote' });
    expect(resolved?.providerSymbol).toBe(providerSymbol);
  });
});
