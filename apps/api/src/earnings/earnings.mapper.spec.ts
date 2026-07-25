import test from 'node:test';
import assert from 'node:assert/strict';
import { EarningsCardPayloadSchema } from '@bourse/analysis';
import { toEarningsCardDto } from './earnings.mapper';

test('earnings mapper preserves both values for a reconciliation conflict', () => {
  const comparedWith = {
    kind: 'structuredSource' as const,
    provider: 'eastmoney-financials',
    sourceUrl: 'https://example.com/financials',
    fieldPath: 'FY2025.income.revenue',
    asOf: '2026-07-20T00:00:00.000Z',
  };
  const payload = EarningsCardPayloadSchema.parse({
    schemaVersion: 'earnings-card-v2',
    event: {
      instrumentId: 'CN:600519',
      periodEndOn: '2025-12-31',
      periodType: 'FY',
      fiscalYear: 2025,
      reportingScope: 'consolidated',
    },
    filing: {
      filingId: 'filing-1',
      formType: 'preliminary',
      sourceUrl: 'https://example.com/filing.pdf',
      publishedAt: '2026-01-20T00:00:00.000Z',
      provider: 'cninfo',
      unaudited: true,
    },
    facts: [{
      id: 'fact-1',
      metricCode: 'revenue',
      value: { kind: 'scalar', value: '10000000000' },
      unit: 'currency',
      currency: 'CNY',
      scale: 1,
      periodStartOn: '2025-01-01',
      periodEndOn: '2025-12-31',
      periodKind: 'duration',
      accumulation: 'FY',
      accountingBasis: 'CAS',
      consolidationScope: 'consolidated',
      derivation: { kind: 'reported' },
      provenance: {
        kind: 'filingSpan',
        filingId: 'filing-1',
        derivationId: 'derivation-1',
        contentHash: 'a'.repeat(64),
        quote: '营业收入100亿元',
        startOffset: 0,
        endOffset: 10,
      },
      comparisons: [],
      checkStatus: { status: 'passed', checks: ['source_anchor'] },
      reconcileStatus: {
        status: 'conflicted',
        comparedWith,
        sourceValue: { kind: 'scalar', value: '10000000000' },
        structuredValue: { kind: 'scalar', value: '9800000000' },
        delta: '200000000',
      },
    }],
    managementClaims: [],
    omittedFactCount: 0,
    statusSummary: { total: 1, reconciled: 0, pending: 0, conflicted: 1, structuredOnly: 0 },
    generatedAt: '2026-07-20T00:00:00.000Z',
  });
  const dto = toEarningsCardDto({
    id: 'revision-1',
    revisionNo: 1,
    status: 'PARTIAL',
    payload,
    generatedAt: new Date('2026-07-20T00:00:00.000Z'),
    supersededAt: null,
    card: {
      id: 'card-1',
      event: {
        stockId: 'stock-1',
        stock: { symbol: '600519', name: '贵州茅台', market: 'CN' },
      },
    },
  });
  const status = dto.facts[0].reconcileStatus;
  assert.equal(status.status, 'conflicted');
  if (status.status === 'conflicted') {
    assert.equal(status.sourceValue.kind, 'scalar');
    assert.equal(status.structuredValue.kind, 'scalar');
  }
});
