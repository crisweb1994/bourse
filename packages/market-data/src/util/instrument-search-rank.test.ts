import { describe, expect, it } from 'vitest';
import { rankInstrumentSearchResults } from './instrument-search-rank';

const mpngy = { symbol: 'MPNGY', name: '美团', market: 'US', exchange: 'OTC', currency: 'USD', yahooSymbol: 'MPNGY' };
const meituanHk = { symbol: '3690', name: '美团w', market: 'HK', exchange: 'HKEX', currency: 'HKD', yahooSymbol: '3690.HK' };
const meituanFrankfurt = { symbol: '9MDA', name: 'Meituan', market: 'FRA', exchange: 'Frankfurt', currency: 'EUR', yahooSymbol: '9MDA.F' };

describe('rankInstrumentSearchResults', () => {
  it('floats the HK primary listing above the US OTC ADR for a company-name query', () => {
    const ranked = rankInstrumentSearchResults([mpngy, meituanHk], '美团');
    expect(ranked.map((item) => item.symbol)).toEqual(['3690', 'MPNGY']);
  });

  it('demotes OTC and secondary listings while keeping primary exchanges first', () => {
    const ranked = rankInstrumentSearchResults([mpngy, meituanFrankfurt, meituanHk], 'meituan');
    // 主上市第一；次级外国交易所（-10）排在 OTC/粉单（-30）之前。
    expect(ranked.map((item) => item.symbol)).toEqual(['3690', '9MDA', 'MPNGY']);
  });

  it('respects an exact symbol query even for an OTC ticker', () => {
    const ranked = rankInstrumentSearchResults([meituanHk, mpngy], 'MPNGY');
    expect(ranked.map((item) => item.symbol)).toEqual(['MPNGY', '3690']);
  });

  it('keeps the original order when scores tie', () => {
    const a = { symbol: 'A', name: 'A', market: 'US', exchange: 'NASDAQ', currency: 'USD', yahooSymbol: 'A' };
    const b = { symbol: 'B', name: 'B', market: 'US', exchange: 'NYSE', currency: 'USD', yahooSymbol: 'B' };
    const ranked = rankInstrumentSearchResults([a, b], 'company');
    expect(ranked.map((item) => item.symbol)).toEqual(['A', 'B']);
  });
});
