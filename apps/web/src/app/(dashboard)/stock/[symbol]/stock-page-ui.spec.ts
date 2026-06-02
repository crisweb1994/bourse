import assert from 'node:assert/strict';
import {
  buildRightInsightsSummary,
  formatAnalysisTime,
  getRequestedAnalysisId,
} from './stock-page-ui';

assert.equal(
  formatAnalysisTime('2026-05-23T06:08:00.000Z', 'zh-CN', 'UTC'),
  '2026/05/23 06:08',
);

assert.equal(
  getRequestedAnalysisId(
    new URLSearchParams('stockId=s1&debateBase=a-from-debate-base'),
  ),
  'a-from-debate-base',
);

assert.equal(
  getRequestedAnalysisId(
    new URLSearchParams(
      'analysisId=a-direct&debateBase=a-from-debate-base',
    ),
  ),
  'a-direct',
);

const fallbackInsights = buildRightInsightsSummary(null, [
  {
    type: 'FUNDAMENTAL',
    status: 'completed',
    structuredJson: {
      conclusion: {
        signal: 'NEUTRAL',
        confidence: 'LOW',
        oneLiner: '基本面数据不足，暂不做强判断。',
      },
    },
  },
  {
    type: 'VALUATION',
    status: 'completed',
    structuredJson: {
      conclusion: {
        signal: 'BULLISH',
        confidence: 'MEDIUM',
        oneLiner: '估值处于合理偏低区间。',
      },
    },
  },
]);

assert.equal(fallbackInsights?.sectionSignals?.length, 2);
assert.equal(fallbackInsights?.sectionSignals?.[1].type, 'VALUATION');
assert.equal(fallbackInsights?.sectionSignals?.[1].signal, 'BULLISH');

console.log('stock-page-ui helper assertions passed');
