import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildEarningsExtractionDerivationKey,
  decideFilingRelation,
  guidanceSourceSupportsCandidate,
  isUnaudited,
  mergeEarningsCardPayload,
  parseEarningsExtractionTimeoutMs,
  parseEarningsGenerationConcurrency,
  structuredFallbackPeriodError,
} from './earnings-runner.service';
import type { EarningsCardPayload } from '@bourse/analysis';

const span = (filingId: string, quote: string) => ({
  kind: 'filingSpan' as const,
  filingId,
  derivationId: `${filingId}-derivation`,
  contentHash: 'a'.repeat(64),
  quote,
  startOffset: 0,
  endOffset: quote.length,
});

function payload(
  filingId: string,
  formType: string,
  publishedAt: string,
  value: string,
  metricCode: 'revenue' | 'netIncome',
): EarningsCardPayload {
  return {
    schemaVersion: 'earnings-card-v2',
    event: {
      instrumentId: 'US:TEST',
      periodEndOn: '2025-12-31',
      periodType: 'FY',
      fiscalYear: 2025,
      reportingScope: 'consolidated',
    },
    filing: {
      sourceKind: 'filing',
      filingId,
      formType,
      sourceUrl: `https://example.com/${filingId}`,
      publishedAt,
      provider: 'sec-edgar',
      unaudited: formType === '8-K',
    },
    supportingFilings: [],
    facts: [{
      id: `${filingId}-${metricCode}`,
      metricCode,
      value: { kind: 'scalar', value },
      normalizedValue: { kind: 'scalar', value },
      unit: 'currency',
      currency: 'USD',
      scale: 1,
      periodStartOn: '2025-01-01',
      periodEndOn: '2025-12-31',
      periodKind: 'duration',
      accumulation: 'FY',
      accountingBasis: 'GAAP',
      consolidationScope: 'consolidated',
      derivation: { kind: 'reported' },
      provenance: span(filingId, `${metricCode} ${value}`),
      comparisons: [],
      checkStatus: { status: 'passed', checks: ['source_anchor'] },
      reconcileStatus: { status: 'pending' },
    }],
    managementClaims: [],
    omittedFactCount: 0,
    statusSummary: { total: 1, reconciled: 0, pending: 1, conflicted: 0, structuredOnly: 0 },
    generatedAt: '2026-01-01T00:00:00.000Z',
  };
}

test('filing relation keeps an 8-K earnings release and 10-Q as supplements', () => {
  assert.equal(
    decideFilingRelation(
      { formType: '10-Q', title: 'Quarterly report' },
      [{ formType: '8-K', title: 'Earnings release' }],
    ),
    'SUPPLEMENTS',
  );
});

test('filing relation advances preview to preliminary report', () => {
  assert.equal(
    decideFilingRelation(
      { formType: 'preliminary', title: '业绩快报' },
      [{ formType: 'preview', title: '业绩预告' }],
    ),
    'SUPERSEDES',
  );
});

test('filing relation marks explicit amendments as corrections', () => {
  assert.equal(
    decideFilingRelation(
      { formType: '8-K/A', title: 'Amended earnings release' },
      [{ formType: '8-K', title: 'Earnings release' }],
    ),
    'CORRECTS',
  );
});

test('supplemental 10-Q keeps the 8-K fact and adds the periodic fact', () => {
  const current = payload('release-1', '8-K', '2026-01-01T00:00:00.000Z', '100', 'revenue');
  const candidate = payload('quarterly-1', '10-Q', '2026-02-01T00:00:00.000Z', '12', 'netIncome');
  const merged = mergeEarningsCardPayload(current, candidate, 'SUPPLEMENTS');
  assert.equal(merged.filing.formType, '10-Q');
  assert.deepEqual(merged.facts.map((fact) => fact.metricCode).sort(), ['netIncome', 'revenue']);
  assert.equal(merged.supportingFilings[0]?.filingId, 'release-1');
});

test('correction replaces the affected metric while retaining an immutable source trail', () => {
  const current = payload('release-1', '8-K', '2026-01-01T00:00:00.000Z', '100', 'revenue');
  const candidate = payload('release-1-amendment', '8-K/A', '2026-01-02T00:00:00.000Z', '98', 'revenue');
  const merged = mergeEarningsCardPayload(current, candidate, 'CORRECTS');
  assert.equal(merged.filing.filingId, 'release-1-amendment');
  assert.equal(merged.facts[0]?.value.kind, 'scalar');
  assert.equal(merged.facts[0]?.value.kind === 'scalar' ? merged.facts[0].value.value : '', '98');
  assert.equal(merged.supportingFilings[0]?.filingId, 'release-1');
});

test('earnings extraction timeout has a bounded production default', () => {
  assert.equal(parseEarningsExtractionTimeoutMs(undefined), 180_000);
  assert.equal(parseEarningsExtractionTimeoutMs('45000'), 45_000);
  assert.throws(
    () => parseEarningsExtractionTimeoutMs('0'),
    /EARNINGS_EXTRACTION_TIMEOUT_MS must be an integer/,
  );
  assert.throws(
    () => parseEarningsExtractionTimeoutMs('not-a-number'),
    /EARNINGS_EXTRACTION_TIMEOUT_MS must be an integer/,
  );
});

test('generation concurrency has a bounded production default', () => {
  assert.equal(parseEarningsGenerationConcurrency(undefined), 4);
  assert.equal(parseEarningsGenerationConcurrency('8'), 8);
  assert.throws(() => parseEarningsGenerationConcurrency('0'), /between 1 and 32/);
  assert.throws(() => parseEarningsGenerationConcurrency('33'), /between 1 and 32/);
});

test('extraction derivations cannot cross filing ownership boundaries', () => {
  const input = {
    filingId: 'filing-1',
    parserDerivationId: 'parser-1',
    sourceHash: 'a'.repeat(64),
    model: 'gpt-5.4',
  };
  assert.notEqual(
    buildEarningsExtractionDerivationKey(input),
    buildEarningsExtractionDerivationKey({ ...input, filingId: 'filing-2' }),
  );
});

test('structured fallback requires the filing and structured periods to match', () => {
  assert.equal(structuredFallbackPeriodError('2026-03-31', '2026-03-31'), null);
  assert.equal(
    structuredFallbackPeriodError(undefined, '2026-03-31')?.code,
    'STRUCTURED_PERIOD_UNCONFIRMED',
  );
  assert.equal(
    structuredFallbackPeriodError('2026-06-30', '2026-03-31')?.code,
    'STRUCTURED_PERIOD_MISMATCH',
  );
});

test('unaudited label requires explicit filing metadata', () => {
  assert.equal(isUnaudited('10-K', 'Annual report', ''), false);
  assert.equal(isUnaudited('8-K', 'Earnings release', ''), false);
  assert.equal(isUnaudited('preliminary', '业绩快报', ''), true);
  assert.equal(isUnaudited('10-Q', 'Quarterly results (unaudited)', ''), true);
});

test('guidance requires an attributable metric and source-supported range', () => {
  const base = {
    metricCode: 'revenue',
    value: { min: '100', max: '120' },
    unit: 'currency',
    scale: 1_000_000,
  };
  assert.equal(guidanceSourceSupportsCandidate('Revenue is expected to be between 100 and 120.', base), true);
  assert.equal(guidanceSourceSupportsCandidate('Revenue is expected to be 110, plus or minus 9.09%.', base), true);
  assert.equal(guidanceSourceSupportsCandidate('Analysts expect between 100 and 120.', base), false);
  assert.equal(guidanceSourceSupportsCandidate('Revenue is expected to be 105 to 120.', base), false);
});
