import assert from 'node:assert/strict';
import {
  buildStockAnalysisUrl,
  findOngoingAnalysis,
  INITIAL_LIFECYCLE_STATE,
  isAlreadyRunningError,
  lifecycleReducer,
} from './stock-analysis-lifecycle-state';
import type { AnalysisHistoryItemDto } from '@/lib/api';
import type { AnalysisStatus } from '@bourse/shared-types';

function analysis(id: string, status: AnalysisStatus): AnalysisHistoryItemDto {
  return {
    id,
    userId: 'user-1',
    stockId: 'stock-1',
    symbol: 'AAPL',
    market: 'US',
    analysisType: 'COMPREHENSIVE',
    status,
    aiProvider: null,
    aiModel: null,
    dataAsOf: null,
    generatedAt: null,
    overallSignal: null,
    overallConfidence: null,
    createdAt: '2026-07-10T00:00:00.000Z',
    stock: {
      id: 'stock-1',
      symbol: 'AAPL',
      name: 'Apple',
      market: 'US',
      exchange: 'NASDAQ',
      currency: 'USD',
      yahooSymbol: 'AAPL',
    },
    sections: [],
  };
}

assert.equal(
  findOngoingAnalysis([
    analysis('done', 'COMPLETED'),
    analysis('pending', 'PENDING'),
    analysis('running', 'IN_PROGRESS'),
  ])?.id,
  'pending',
);

assert.equal(
  isAlreadyRunningError(new Error('Analysis is already in progress')),
  true,
);
assert.equal(isAlreadyRunningError(new Error('provider failed')), false);

assert.equal(
  buildStockAnalysisUrl({
    symbol: 'BRK B',
    stockId: 'stock-1',
    analysisId: 'analysis-1',
  }),
  '/stock/BRK%20B?stockId=stock-1&analysisId=analysis-1',
);

const cancelled = lifecycleReducer(
  {
    ...INITIAL_LIFECYCLE_STATE,
    recentAnalyses: [analysis('a1', 'IN_PROGRESS'), analysis('a2', 'COMPLETED')],
  },
  { t: 'markCancelled', id: 'a1' },
);
assert.equal(cancelled.recentAnalyses[0]?.status, 'CANCELLED');
assert.equal(cancelled.recentAnalyses[1]?.status, 'COMPLETED');

console.log('stock-analysis-lifecycle-state assertions passed');
