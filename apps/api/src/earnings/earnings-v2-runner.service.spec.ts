import test from 'node:test';
import assert from 'node:assert/strict';
import { FinancialsBundleV2Schema, type FinancialsBundleV2, type ProviderFinancialsV2Port } from '@bourse/market-data';
import {
  buildV2FinancialsConnector,
  EarningsV2RunnerService,
  identityFromFilingMetadata,
  resolveV2Identity,
} from './earnings-v2-runner.service';
import type { StructuredSelectionService } from './structured-selection.service';

function usBundle(): FinancialsBundleV2 {
  return FinancialsBundleV2Schema.parse({
    schemaVersion: 'financials-v2',
    instrumentId: 'US:TEST',
    provider: 'sec-edgar-xbrl-v2',
    sourceNature: 'official_structured',
    qualityTier: 'A',
    sourceUrl: 'https://data.sec.gov/api/xbrl/companyfacts/CIK0000000001.json',
    retrievedAt: '2025-02-01T00:00:00.000Z',
    snapshotId: 'snap-bundle',
    periods: [
      {
        id: 'period-2025-FY',
        fiscalYear: 2025,
        fiscalPeriodType: 'FY',
        periodStartOn: '2025-01-01',
        periodEndOn: '2025-12-31',
        publishedAt: '2025-02-01T00:00:00.000Z',
        formType: '10-K',
        reportingScope: 'consolidated',
        accountingBasis: 'US-GAAP',
        revision: { kind: 'original' },
        facts: [
          {
            id: 'fact-revenue-fy',
            metricCode: 'revenue',
            value: '100',
            unit: 'currency',
            currency: 'USD',
            scale: 1,
            periodKind: 'duration',
            periodStartOn: '2025-01-01',
            periodEndOn: '2025-12-31',
            accumulation: 'FY',
            accountingBasis: 'US-GAAP',
            reportingScope: 'consolidated',
            derivation: { kind: 'reported' },
            provenance: {
              provider: 'sec-edgar-xbrl-v2',
              sourceNature: 'official_structured',
              qualityTier: 'A',
              sourceUrl: 'https://data.sec.gov/api/xbrl/companyfacts/CIK0000000001.json',
              sourceField: 'RevenueFromContractWithCustomerExcludingAssessedTax',
              accessionNumber: 'acc-1',
              sourceFiledAt: '2025-02-01T00:00:00.000Z',
              snapshotId: 'snap-bundle',
              retrievedAt: '2025-02-01T00:00:00.000Z',
            },
          },
        ],
      },
    ],
  });
}

class FakeSelectionService {
  snapshots: Array<{ stockId: string; bundle: FinancialsBundleV2 }> = [];
  selections: Array<Record<string, unknown>> = [];

  async saveSnapshot(stockId: string, bundle: FinancialsBundleV2) {
    this.snapshots.push({ stockId, bundle });
    return { id: 'snap-saved-1' };
  }

  async saveSelection(input: Record<string, unknown>) {
    this.selections.push(input);
  }
}

function connectorWith(bundle: FinancialsBundleV2 | null, warnings: Array<{ message: string }> = []): ProviderFinancialsV2Port {
  return {
    async fetchFinancials() {
      return {
        schemaVersion: '1',
        data: bundle,
        citations: [],
        freshness: [],
        warnings,
      } as never;
    },
  };
}

const NOW = '2025-02-01T00:00:00.000Z';

test('resolveV2Identity prefers source metadata over narrative hints', () => {
  const resolved = resolveV2Identity(
    { expectedPeriodEndOn: '2025-12-31', periodType: 'FY', fiscalYear: 2025 },
    { periodEndOn: '2025-03-31', periodType: 'Q1' },
  );
  assert.equal(resolved.source, 'source');
  assert.equal(resolved.identity?.periodEndOn, '2025-12-31');
  assert.equal(resolved.identity?.fiscalYear, 2025);
});

test('resolveV2Identity falls back to narrative hints with diagnostics', () => {
  const resolved = resolveV2Identity({}, { periodEndOn: '2025-03-31', periodType: 'Q1' });
  assert.equal(resolved.source, 'narrative_hint');
  assert.equal(resolved.identity?.periodEndOn, '2025-03-31');
  assert.ok(resolved.diagnostics.length > 0);
});

test('resolveV2Identity reports missing identity', () => {
  const resolved = resolveV2Identity({}, {});
  assert.equal(resolved.source, 'missing');
  assert.equal(resolved.identity, undefined);
});

test('identityFromFilingMetadata parses CN report titles', () => {
  const cases = [
    ['福耀玻璃:2025年半年度报告', 'H1', '2025-06-30'],
    ['福耀玻璃:2025年第三季度报告', '9M', '2025-09-30'],
    ['福耀玻璃:2025年第一季度报告', 'Q1', '2025-03-31'],
    ['福耀玻璃:2025年年度报告', 'FY', '2025-12-31'],
    ['福耀玻璃:2025年年度业绩快报', 'FY', '2025-12-31'],
    ['Tencent Holdings 2025中期报告', 'H1', '2025-06-30'],
  ] as const;
  for (const [title, periodType, periodEndOn] of cases) {
    const resolved = identityFromFilingMetadata({ formType: 'annual', title });
    assert.equal(resolved.identity?.periodType, periodType, title);
    assert.equal(resolved.identity?.periodEndOn, periodEndOn, title);
  }
});

test('identityFromFilingMetadata parses US period-ended titles', () => {
  const q2 = identityFromFilingMetadata({
    formType: '10-Q',
    title: 'Quarterly report for the quarterly period ended June 30, 2025',
  });
  assert.equal(q2.identity?.periodType, 'Q2');
  assert.equal(q2.identity?.periodEndOn, '2025-06-30');

  const fy = identityFromFilingMetadata({
    formType: '10-K',
    title: 'Annual report for the fiscal year ended September 28, 2024',
  });
  assert.equal(fy.identity?.periodType, 'FY');
  assert.equal(fy.identity?.periodEndOn, '2024-09-28');
});

test('resolveV2Identity applies priority: source > title rule > narrative hint', () => {
  const sourceWins = resolveV2Identity(
    { expectedPeriodEndOn: '2025-12-31', periodType: 'FY' },
    { periodEndOn: '2025-03-31', periodType: 'Q1' },
    { formType: 'annual', title: '2025年半年度报告' },
  );
  assert.equal(sourceWins.source, 'source');
  assert.equal(sourceWins.identity?.periodEndOn, '2025-12-31');

  const titleWins = resolveV2Identity(
    {},
    { periodEndOn: '2025-03-31', periodType: 'Q1' },
    { formType: 'annual', title: '福耀玻璃:2025年半年度报告' },
  );
  assert.equal(titleWins.source, 'title_rule');
  assert.equal(titleWins.identity?.periodType, 'H1');

  const hintFallsBack = resolveV2Identity(
    {},
    { periodEndOn: '2025-03-31', periodType: 'Q1' },
    { formType: '10-Q', title: 'Quarterly report [Sections 13 or 15(d)]' },
  );
  assert.equal(hintFallsBack.source, 'narrative_hint');
});

test('buildV2FinancialsConnector returns a connector for US/CN/HK and null otherwise', () => {
  assert.ok(buildV2FinancialsConnector('US'));
  assert.ok(buildV2FinancialsConnector('CN'));
  assert.ok(buildV2FinancialsConnector('HK'));
  assert.equal(buildV2FinancialsConnector('JP'), null);
});

test('runStructuredLane saves snapshot and ready selection for an exact period', async () => {
  const selectionService = new FakeSelectionService();
  const runner = new EarningsV2RunnerService(selectionService as unknown as StructuredSelectionService);
  const result = await runner.runStructuredLane({
    eventId: 'event-1',
    stock: { id: 'stock-1', market: 'US', symbol: 'TEST' },
    identity: { periodEndOn: '2025-12-31', periodType: 'FY' },
    eventPublishedAt: NOW,
    knowledgeCutoffAt: NOW,
    connector: connectorWith(usBundle()),
    now: NOW,
  });

  assert.equal(result.selection.status, 'ready');
  assert.equal(result.snapshotId, 'snap-saved-1');
  assert.equal(selectionService.snapshots.length, 1);
  assert.equal(selectionService.snapshots[0].stockId, 'stock-1');
  assert.equal(selectionService.selections.length, 1);
  assert.equal((selectionService.selections[0].snapshotIds as string[])[0], 'snap-saved-1');
});

test('runStructuredLane returns pending when the exact period is missing', async () => {
  const selectionService = new FakeSelectionService();
  const runner = new EarningsV2RunnerService(selectionService as unknown as StructuredSelectionService);
  const result = await runner.runStructuredLane({
    eventId: 'event-1',
    stock: { id: 'stock-1', market: 'US', symbol: 'TEST' },
    identity: { periodEndOn: '2025-03-31', periodType: 'Q1' },
    eventPublishedAt: NOW,
    knowledgeCutoffAt: NOW,
    connector: connectorWith(usBundle()),
    now: NOW,
  });

  assert.equal(result.selection.status, 'pending');
  if (result.selection.status === 'pending') {
    assert.equal(result.selection.reason, 'no_exact_period');
    assert.equal(selectionService.selections[0].retryAt, '2025-02-01T12:00:00.000Z');
  }
});

test('runStructuredLane returns unsupported with a default retry when the source has no data', async () => {
  const selectionService = new FakeSelectionService();
  const runner = new EarningsV2RunnerService(selectionService as unknown as StructuredSelectionService);
  const result = await runner.runStructuredLane({
    eventId: 'event-1',
    stock: { id: 'stock-1', market: 'CN', symbol: '600519' },
    identity: { periodEndOn: '2025-12-31', periodType: 'FY' },
    eventPublishedAt: NOW,
    knowledgeCutoffAt: NOW,
    connector: connectorWith(null, [{ message: 'no coverage' }]),
    now: NOW,
  });

  assert.equal(result.selection.status, 'unsupported');
  if (result.selection.status === 'unsupported') {
    assert.equal(result.selection.reason, 'source_no_data');
  }
  assert.equal(selectionService.snapshots.length, 0);
  assert.equal(selectionService.selections[0].retryAt, '2025-02-01T00:30:00.000Z');
});
