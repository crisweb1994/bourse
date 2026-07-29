import { describe, expect, it } from 'vitest';
import { DefaultInstrumentResolver } from './resolver';

describe('DefaultInstrumentResolver', () => {
  const resolver = new DefaultInstrumentResolver();

  it.each([
    ['HK:0700', 'tencent-hk', 'hk00700'],
    ['HK:0700', 'yahoo', '0700.HK'],
    ['CN:600519', 'tencent-cn-history', 'sh600519'],
    ['CN:000001', 'cn-finance', '0.000001'],
  ])('maps %s for %s deterministically', (instrumentId, sourceId, providerSymbol) => {
    const resolved = resolver.resolve({ instrumentId, sourceId, capability: 'quote' });
    expect(resolved?.providerSymbol).toBe(providerSymbol);
  });
});
