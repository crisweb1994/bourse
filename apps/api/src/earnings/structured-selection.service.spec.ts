import test from 'node:test';
import assert from 'node:assert/strict';
import type { StructuredEarningsSelection } from '@bourse/analysis';
import { selectionVersionOf, stableHash } from './structured-selection.service';

function readySelection(factIds: string[], periodId = 'period-2025-FY'): StructuredEarningsSelection {
  return {
    status: 'ready',
    period: {
      id: periodId,
      fiscalYear: 2025,
      fiscalPeriodType: 'FY',
      periodEndOn: '2025-12-31',
      reportingScope: 'consolidated',
      accountingBasis: 'US-GAAP',
      revision: { kind: 'original' },
      facts: [],
    },
    facts: factIds.map((id) => ({ id }) as never),
    diagnostics: { expected: {} as never, candidatePeriods: [], rejected: [], warnings: [] },
  };
}

test('selectionVersionOf is stable regardless of fact order', () => {
    const a = selectionVersionOf(readySelection(['fact-b', 'fact-a']));
    const b = selectionVersionOf(readySelection(['fact-a', 'fact-b']));
    assert.equal(a, b);
});

test('selectionVersionOf changes when the selected period changes', () => {
    const a = selectionVersionOf(readySelection(['fact-a'], 'period-2025-FY'));
    const b = selectionVersionOf(readySelection(['fact-a'], 'period-2025-Q1'));
    assert.notEqual(a, b);
});

test('selectionVersionOf changes when the status changes', () => {
    const ready = selectionVersionOf(readySelection(['fact-a']));
    const pending: StructuredEarningsSelection = {
      status: 'pending',
      reason: 'no_exact_period',
      retryAt: '2025-01-01T00:00:00.000Z',
      diagnostics: { expected: {} as never, candidatePeriods: [], rejected: [], warnings: [] },
    };
    assert.notEqual(selectionVersionOf(pending), ready);
});

test('stableHash is key-order independent', () => {
    assert.equal(
      stableHash({ a: 1, b: { c: 2, d: [1, 2] } }),
      stableHash({ b: { d: [1, 2], c: 2 }, a: 1 }),
    );
});
