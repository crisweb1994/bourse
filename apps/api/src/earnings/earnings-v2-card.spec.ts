import test from 'node:test';
import assert from 'node:assert/strict';
import type { StructuredEarningsSelection } from '@bourse/analysis';
import {
  buildV2CardPayload,
  buildV2FilingDescriptor,
  numericStatusOf,
} from './earnings-v2-card';

function selectionWith(status: StructuredEarningsSelection['status']): StructuredEarningsSelection {
  if (status === 'ready') {
    return {
      status: 'ready',
      period: {
        id: 'period-2025-FY',
        fiscalYear: 2025,
        fiscalPeriodType: 'FY',
        periodEndOn: '2025-12-31',
        reportingScope: 'consolidated',
        accountingBasis: 'US-GAAP',
        revision: { kind: 'original' },
        facts: [],
      },
      facts: [],
      diagnostics: { expected: {} as never, candidatePeriods: [], rejected: [], warnings: [] },
    };
  }
  if (status === 'pending') {
    return {
      status: 'pending',
      reason: 'no_exact_period',
      retryAt: '2025-01-02T00:00:00.000Z',
      diagnostics: { expected: {} as never, candidatePeriods: [], rejected: [], warnings: [] },
    };
  }
  if (status === 'ambiguous') {
    return {
      status: 'ambiguous',
      reason: 'conflicting_metric_revenue',
      candidates: [],
      facts: [],
      diagnostics: { expected: {} as never, candidatePeriods: [], rejected: [], warnings: [] },
    };
  }
  return {
    status: 'unsupported',
    reason: 'no_supported_metric',
    diagnostics: { expected: {} as never, candidatePeriods: [], rejected: [], warnings: [] },
  };
}

const span = {
  kind: 'filingSpan' as const,
  filingId: 'filing-1',
  derivationId: 'derivation-1',
  contentHash: 'a'.repeat(64),
  quote: 'Revenue increased 10%',
  startOffset: 0,
  endOffset: 20,
};

test('numericStatusOf maps selection statuses to dataStatus.numeric', () => {
  assert.equal(numericStatusOf(selectionWith('ready')), 'ready');
  assert.equal(numericStatusOf(selectionWith('pending')), 'pending_structured');
  assert.equal(numericStatusOf(selectionWith('ambiguous')), 'ambiguous');
  assert.equal(numericStatusOf(selectionWith('unsupported')), 'unsupported');
});

test('buildV2CardPayload assembles a ready card with claims and non-GAAP', () => {
  const payload = buildV2CardPayload({
    schemaVersion: 'earnings-v2',
    event: {
      instrumentId: 'US:AAPL',
      periodEndOn: '2025-12-31',
      periodType: 'FY',
      fiscalYear: 2025,
      reportingScope: 'consolidated',
    },
    filing: {
      sourceKind: 'filing',
      filingId: 'filing-1',
      formType: '10-K',
      sourceUrl: 'https://www.sec.gov/Archives/edgar/data/1/0000000001-25-000001-index.html',
      publishedAt: '2025-02-01T00:00:00.000Z',
      provider: 'sec-edgar',
      unaudited: false,
      relationType: 'SUPPLEMENTS',
    },
    facts: [],
    selection: selectionWith('ready'),
    managementClaims: [{ id: 'claim-1', text: 'Revenue increased 10%', sourceSpan: span }],
    supplementalNonGaap: [
      {
        metricLabel: 'Non-GAAP EPS',
        value: { kind: 'scalar', value: '2.5' },
        unit: 'per_share',
        currency: 'USD',
        targetPeriodEndOn: '2025-12-31',
        reconciliationContext: 'Excludes SBC.',
        sourceSpan: span,
      },
    ],
    narrativeStatus: 'ready',
    guidanceStatus: 'none_reported',
    generatedAt: '2025-02-01T00:00:00.000Z',
  });

  assert.equal(payload.dataStatus?.numeric, 'ready');
  assert.equal(payload.dataStatus?.narrative, 'ready');
  assert.equal(payload.dataStatus?.guidance, 'none_reported');
  assert.equal(payload.managementClaims.length, 1);
  assert.equal(payload.supplementalNonGaap.length, 1);
  assert.equal(payload.supplementalNonGaap[0].metricLabel, 'Non-GAAP EPS');
});

test('buildV2CardPayload marks pending when numeric data is unavailable', () => {
  const payload = buildV2CardPayload({
    schemaVersion: 'earnings-v2',
    event: {
      instrumentId: 'US:AAPL',
      periodEndOn: '2025-03-31',
      periodType: 'Q1',
      fiscalYear: 2025,
      reportingScope: 'consolidated',
    },
    filing: {
      sourceKind: 'filing',
      filingId: 'filing-1',
      formType: '8-K',
      sourceUrl: 'https://www.sec.gov/Archives/edgar/data/1/0000000001-25-000001-index.html',
      publishedAt: '2025-02-01T00:00:00.000Z',
      provider: 'sec-edgar',
      unaudited: true,
      relationType: 'SUPPLEMENTS',
    },
    facts: [],
    selection: selectionWith('pending'),
    managementClaims: [],
    supplementalNonGaap: [],
    narrativeStatus: 'ready',
    guidanceStatus: 'none_reported',
    generatedAt: '2025-02-01T00:00:00.000Z',
  });

  assert.equal(payload.dataStatus?.numeric, 'pending_structured');
  assert.equal(payload.facts.length, 0);
  assert.equal(payload.statusSummary.structuredOnly, 0);
});

test('buildV2FilingDescriptor normalizes null language and title', () => {
  const descriptor = buildV2FilingDescriptor({
    filingId: 'filing-1',
    formType: '10-Q',
    title: null,
    sourceUrl: 'https://www.sec.gov/Archives/edgar/data/1/0000000001-25-000001-index.html',
    publishedAt: '2025-02-01T00:00:00.000Z',
    provider: 'sec-edgar',
    language: null,
    unaudited: false,
    relationType: 'SUPPLEMENTS',
  });
  assert.equal(descriptor.language, undefined);
  assert.equal(descriptor.title, undefined);
  assert.equal(descriptor.filingId, 'filing-1');
});

test('buildV2FilingDescriptor preserves a valid language', () => {
  const descriptor = buildV2FilingDescriptor({
    filingId: 'filing-1',
    formType: 'annual',
    title: '2025年半年度报告',
    sourceUrl: 'https://example.com/filing',
    publishedAt: '2025-08-20T00:00:00.000Z',
    provider: 'eastmoney',
    language: 'zh-CN',
    unaudited: false,
    relationType: 'SUPPLEMENTS',
  });
  assert.equal(descriptor.language, 'zh-CN');
  assert.equal(descriptor.title, '2025年半年度报告');
});
