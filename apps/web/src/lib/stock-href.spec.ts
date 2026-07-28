import assert from 'node:assert/strict';
import { stockHref } from './stock-href';

assert.equal(
  stockHref({
    symbol: '600519',
    yahooSymbol: '600519.SS',
    market: 'CN',
    name: '贵州茅台',
  }),
  '/stock/600519.SS?market=CN&name=%E8%B4%B5%E5%B7%9E%E8%8C%85%E5%8F%B0',
);

assert.equal(
  stockHref(
    {
      id: 'stock-1',
      symbol: 'AAPL',
      yahooSymbol: 'AAPL',
      market: 'US',
      name: 'Apple Inc.',
    },
    { analysisId: 'analysis-1' },
  ),
  '/stock/AAPL?stockId=stock-1&market=US&name=Apple+Inc.&analysisId=analysis-1',
);

console.log('stock-href helper assertions passed');
