import assert from 'node:assert/strict';
import { buildStockAnalysisUrl, findOngoingAnalysis } from './stock-analysis-lifecycle-state';
import type { AnalysisHistoryItemDto } from '@/lib/api';

const analysis = (id: string, status: AnalysisHistoryItemDto['status']): AnalysisHistoryItemDto => ({
  id, userId: 'user-1', stockId: 'stock-1', symbol: 'AAPL', mode: 'QUICK', focusWindow: '90D', question: null, status,
  aiProvider: null, aiModel: null, dataAsOf: null, completedAt: null, startedAt: null, overallSignal: null, overallConfidence: null, createdAt: '2026-07-10T00:00:00.000Z', sections: [], stock: { id: 'stock-1', symbol: 'AAPL', name: 'Apple', market: 'US', exchange: 'NASDAQ', currency: 'USD', yahooSymbol: 'AAPL' },
});
assert.equal(findOngoingAnalysis([analysis('done', 'COMPLETED'), analysis('pending', 'PENDING')])?.id, 'pending');
assert.equal(buildStockAnalysisUrl({ symbol: 'BRK B', stockId: 'stock-1', analysisId: 'analysis-1', market: 'US', name: 'Berkshire Hathaway' }), '/stock/BRK%20B?stockId=stock-1&analysisId=analysis-1&market=US&name=Berkshire+Hathaway');
console.log('stock-analysis-lifecycle-state assertions passed');
