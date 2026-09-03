import test from 'node:test';
import assert from 'node:assert/strict';
import { BadRequestException } from '@nestjs/common';
import { EarningsTrendService, factCompatibilityFingerprint } from './earnings-trend.service';

function card(
  year: number,
  quarter: number,
  value: string,
  accumulation: 'discrete' | 'YTD' = 'discrete',
) {
  // Prisma 枚举无 Q4（年末走 FY），fixture 与真实事件对齐。
  const periodType =
    quarter === 4 ? 'FY' : quarter === 2 && accumulation === 'YTD' ? 'H1' : `Q${quarter}`;
  const month = String(quarter * 3).padStart(2, '0');
  const day = quarter === 1 || quarter === 4 ? '31' : '30';
  const periodEndOn = `${year}-${month}-${day}`;
  return {
    id: `event-${year}-q${quarter}-${accumulation}`,
    currentRevisionId: `revision-${year}-q${quarter}-${accumulation}`,
    fiscalYear: year,
    periodType,
    periodEndOn: new Date(`${periodEndOn}T00:00:00.000Z`),
    currentRevision: {
      id: `revision-${year}-q${quarter}-${accumulation}`,
      payload: {
        schemaVersion: 'earnings-v1',
        event: {
          instrumentId: 'US:AAPL',
          periodEndOn,
          periodType,
          fiscalYear: year,
          fiscalQuarter: quarter,
          reportingScope: 'consolidated',
        },
        filing: {
          sourceKind: 'filing',
          filingId: `filing-${year}-${quarter}`,
          formType: 'quarterly',
          sourceUrl: `https://example.com/${year}/${quarter}`,
          publishedAt: `${year}-07-01T00:00:00.000Z`,
          provider: 'fixture',
          unaudited: true,
        },
        supportingFilings: [],
        facts: [{
          id: `fact-${year}-${quarter}-${accumulation}`,
          metricCode: 'revenue',
          value: { kind: 'scalar', value },
          unit: 'currency',
          currency: 'USD',
          scale: 1,
          periodStartOn: `${year}-01-01`,
          periodEndOn,
          periodKind: 'duration',
          accumulation,
          accountingBasis: 'US-GAAP',
          consolidationScope: 'consolidated',
          derivation: { kind: 'reported' },
          provenance: {
            kind: 'filingSpan',
            filingId: `filing-${year}-${quarter}`,
            derivationId: 'derivation-1',
            contentHash: 'a'.repeat(64),
            quote: 'Revenue was reported.',
            startOffset: 0,
            endOffset: 21,
          },
          comparisons: [],
          checkStatus: { status: 'passed', checks: [] },
          reconcileStatus: {
            status: 'reconciled',
            comparedWith: {
              kind: 'structuredSource',
              provider: 'fixture',
              sourceUrl: 'https://example.com/data',
              fieldPath: 'revenue',
              asOf: `${year}-07-01T00:00:00.000Z`,
            },
            delta: '0',
          },
        }],
        dataStatus: { numeric: 'ready', narrative: 'unavailable', guidance: 'none_reported' },
        managementClaims: [],
        omittedFactCount: 0,
        statusSummary: { total: 1, reconciled: 1, pending: 0, conflicted: 0, structuredOnly: 0 },
        generatedAt: `${year}-07-01T00:00:01.000Z`,
      },
    },
  };
}

function service(cards: ReturnType<typeof card>[]) {
  const prisma = {
    stock: { findUnique: async () => ({ id: 'stock-1' }) },
    earningsEvent: { findMany: async () => cards },
  };
  return new EarningsTrendService(prisma as any);
}

function sourceFingerprint() {
  return factCompatibilityFingerprint({
    metricCode: 'revenue',
    valueKind: 'SCALAR',
    unit: 'currency',
    currency: 'USD',
    periodKind: 'duration',
    accumulation: 'discrete',
    accountingBasis: 'US-GAAP',
    consolidationScope: 'consolidated',
    derivationKind: 'SOURCE',
  });
}

test('trend computes fiscal-aware YoY and QoQ from current revision payloads', async () => {
  const result = await service([
    card(2026, 2, '150'),
    card(2026, 1, '120'),
    card(2025, 2, '100'),
  ]).series('stock-1', 'revenue', 8, sourceFingerprint());
  const latest = result.points.at(-1)!;
  assert.equal(latest.yoy?.percentDelta, '50');
  assert.equal(latest.qoq?.percentDelta, '25');
  assert.equal(latest.sourceUrl, 'https://example.com/2026/2');
});

test('four displayed periods can use an older hidden YoY base', async () => {
  const result = await service([
    card(2026, 4, '160'),
    card(2026, 3, '150'),
    card(2026, 2, '140'),
    card(2026, 1, '130'),
    card(2025, 4, '100'),
  ]).series('stock-1', 'revenue', 4, sourceFingerprint());
  assert.equal(result.points.at(-1)?.yoy?.percentDelta, '60');
});

test('trend derives a discrete Q2 point from H1 and Q1 cumulative facts', async () => {
  const svc = service([card(2026, 2, '260', 'YTD'), card(2026, 1, '100', 'YTD')]);
  const option = (await svc.options('stock-1')).find(
    (candidate) => candidate.derivationKind === 'YTD_DIFFERENCE',
  );
  assert.ok(option);
  const result = await svc.series('stock-1', 'revenue', 8, option.fingerprint);
  const point = result.points[0];
  assert.equal(point?.value.kind, 'scalar');
  assert.equal(point?.value.kind === 'scalar' ? point.value.value : '', '160');
  assert.equal(point?.periodType, 'Q2');
  assert.equal(point?.periodStartOn, '2026-04-01');
});

test('trend rejects fingerprints not issued by the options endpoint', async () => {
  await assert.rejects(
    () => service([card(2026, 1, '120')]).series('stock-1', 'revenue', 8, 'client-crafted'),
    BadRequestException,
  );
});
