import assert from 'node:assert/strict';
import { buildRightInsightsSummary, formatAnalysisTime, getRequestedAnalysisId, inferMarketFromSymbol } from './stock-page-ui';

assert.equal(formatAnalysisTime('2026-05-23T06:08:00.000Z', 'zh-CN', 'UTC'), '2026/05/23 06:08');
assert.equal(inferMarketFromSymbol('0700.HK'), 'HK');
assert.equal(inferMarketFromSymbol('600519.SS'), 'CN');
assert.equal(inferMarketFromSymbol('AAPL'), 'US');
assert.equal(getRequestedAnalysisId(new URLSearchParams('analysisId=a-direct')), 'a-direct');
assert.equal(buildRightInsightsSummary(null, [{ type: 'COMPANY_QUALITY', status: 'completed', structuredJson: { assessment: 'STRONG' } }])?.signal, null);
console.log('stock-page-ui helper assertions passed');
