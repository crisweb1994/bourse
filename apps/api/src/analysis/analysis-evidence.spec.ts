import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ChartEvidenceResponseSchema } from '@bourse/shared-types';
import { NotFoundException } from '@nestjs/common';
import { AnalysisQueryService } from './analysis-query.service';

/**
 * Contract tests for GET /api/analysis/:id/evidence (visualization §五⑥).
 * Every branch's response must parse against the shared zod schema — the
 * DTO is an executable contract, not a comment.
 */

function makeService(row: unknown) {
  const prisma = {
    analysis: {
      findFirst: async () => row,
    },
  };
  return new AnalysisQueryService(prisma as never);
}

const snapshotRow = (payload: unknown) => ({
  evidenceSnapshot: {
    capturedAt: new Date('2026-08-15T02:00:00.000Z'),
    degraded: false,
    payload,
  },
});

const modernPack = {
  schemaVersion: 'evidence-pack-v2',
  symbol: 'AAPL',
  market: 'US',
  capturedAt: '2026-08-15T02:00:00.000Z',
  facts: {
    quote: { value: 305.93, asOf: '2026-08-14', sourceTier: 'B', sourceUrl: 'https://y' },
    currency: { value: 'USD', sourceTier: 'B', sourceUrl: 'https://y' },
    financials: { value: { periods: [] }, sourceTier: 'A', sourceUrl: 'https://sec' },
  },
  dataAvailability: {
    complete: ['quote', 'history'],
    missing: [{ field: 'consensusEps', reason: 'not_implemented' }],
    fallbacks: [],
  },
  computedFacts: {
    technical: { asOf: '2026-08-14T20:00:00.000Z', bars: 251, sma20: 300, series: { sma20: [{ t: '2026-01-15', v: 290 }] } },
    ratios: { periodTrends: [{ period: 'FY2025', revenue: 400 }] },
    valuation: { pe5yMedian: 30, peHistorySeries: [{ period: 'FY2025', pe: 34 }] },
  },
  priceSeries: {
    bars: [{ t: '2026-08-14', o: 300, h: 310, l: 299, c: 305.93, v: 28_000_000 }],
    basis: 'derived',
    week52High: 310,
    week52Low: 164,
    asOf: '2026-08-14',
    sourceTier: 'B',
  },
  researchCoverage: { overallStatus: 'PASS' },
};

test('evidence: analysis not found → 404', async () => {
  const service = makeService(null);
  await assert.rejects(() => service.getChartEvidence('user-1', 'missing'), NotFoundException);
});

test('evidence: no snapshot → available:false + stable reason, schema-valid', async () => {
  const service = makeService({ evidenceSnapshot: null });
  const res = await service.getChartEvidence('user-1', 'a-1');
  assert.equal(res.available, false);
  assert.equal(res.reason, 'no_snapshot');
  const parsed = ChartEvidenceResponseSchema.safeParse(res);
  assert.equal(parsed.success, true, JSON.stringify(parsed.success ? '' : parsed.error.issues));
});

test('evidence: modern snapshot → available:true with full projection, schema-valid', async () => {
  const service = makeService(snapshotRow(modernPack));
  const res = await service.getChartEvidence('user-1', 'a-1');
  assert.equal(res.available, true);
  assert.equal(res.capturedAt, '2026-08-15T02:00:00.000Z');
  // quote projection (C3 current-price feed)
  assert.equal(res.chartFacts.quote?.price, 305.93);
  assert.equal(res.chartFacts.quote?.currency, 'USD');
  // priceSeries passthrough (C1 feed)
  assert.equal(res.chartFacts.priceSeries?.basis, 'derived');
  assert.equal(res.chartFacts.priceSeries?.bars[0]?.c, 305.93);
  // computedFacts subtrees
  assert.equal((res.chartFacts.technical as { sma20?: number }).sma20, 300);
  assert.equal(res.chartFacts.ratios?.periodTrends.length, 1);
  assert.ok(res.chartFacts.valuation);
  // structured availability + provenance tiers
  assert.equal(res.dataAvailability.missing[0]?.field, 'consensusEps');
  assert.equal(res.provenance.quote, 'B');
  assert.equal(res.provenance.financials, 'A');
  assert.equal(res.provenance.history, 'B');
  assert.deepEqual(res.researchCoverage, { overallStatus: 'PASS' });
  const parsed = ChartEvidenceResponseSchema.safeParse(res);
  assert.equal(parsed.success, true, JSON.stringify(parsed.success ? '' : parsed.error.issues));
});

test('evidence: legacy snapshot (pre-visualization, no priceSeries) → nulls, schema-valid', async () => {
  const legacy = { ...modernPack, priceSeries: undefined, computedFacts: { ratios: null, technical: null, valuation: null } };
  const service = makeService(snapshotRow(legacy));
  const res = await service.getChartEvidence('user-1', 'a-1');
  assert.equal(res.available, true);
  assert.equal(res.chartFacts.priceSeries, null);
  assert.equal(res.chartFacts.ratios, null);
  assert.equal(res.provenance.history, undefined);
  const parsed = ChartEvidenceResponseSchema.safeParse(res);
  assert.equal(parsed.success, true, JSON.stringify(parsed.success ? '' : parsed.error.issues));
});

test('evidence: degraded snapshot flag passes through', async () => {
  const service = makeService({
    evidenceSnapshot: { capturedAt: new Date('2026-08-15T02:00:00.000Z'), degraded: true, payload: modernPack },
  });
  const res = await service.getChartEvidence('user-1', 'a-1');
  assert.equal(res.degraded, true);
  assert.equal(ChartEvidenceResponseSchema.safeParse(res).success, true);
});
