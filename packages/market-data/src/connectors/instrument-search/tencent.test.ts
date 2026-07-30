import { describe, expect, it } from 'vitest';
import { parseTencentSearchResponse } from './tencent';

describe('parseTencentSearchResponse', () => {
  it('parses US, CN and HK equities into canonical search results', () => {
    const body =
      'v_hint="us~aapl.oq~\\u82f9\\u679c~pg~GP^sh~600519~\\u8d35\\u5dde\\u8305\\u53f0~gzmt~GP-A^hk~00700~\\u817e\\u8baf\\u63a7\\u80a1~txkg~GP"';

    expect(parseTencentSearchResponse(body)).toEqual([
      { symbol: 'AAPL', name: '苹果', market: 'US', exchange: 'NASDAQ', currency: 'USD', yahooSymbol: 'AAPL' },
      { symbol: '600519', name: '贵州茅台', market: 'CN', exchange: 'SSE', currency: 'CNY', yahooSymbol: '600519.SS' },
      { symbol: '0700', name: '腾讯控股', market: 'HK', exchange: 'HKEX', currency: 'HKD', yahooSymbol: '0700.HK' },
    ]);
  });

  it('keeps ETFs and filters indices, funds and warrants', () => {
    const body =
      'v_hint="sh~510300~\\u6caa\\u6df1300ETF~hs300~ETF^sh~000001~\\u4e0a\\u8bc1\\u6307\\u6570~szzs~ZS^jj~070012~\\u57fa\\u91d1~jj~QDII^hk~13005~\\u8ba4\\u8d2d\\u8bc1~qz~QZ"';

    expect(parseTencentSearchResponse(body)).toEqual([
      { symbol: '510300', name: '沪深300ETF', market: 'CN', exchange: 'SSE', currency: 'CNY', yahooSymbol: '510300.SS' },
    ]);
  });

  it('returns an empty result for malformed provider payloads', () => {
    expect(parseTencentSearchResponse('not javascript')).toEqual([]);
    expect(parseTencentSearchResponse('v_hint=not-json')).toEqual([]);
  });
});
