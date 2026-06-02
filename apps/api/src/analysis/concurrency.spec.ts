import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseAnalysisConcurrency } from './concurrency';

describe('parseAnalysisConcurrency', () => {
  it('falls back to default concurrency for invalid config values', () => {
    assert.equal(parseAnalysisConcurrency(undefined), 4);
    assert.equal(parseAnalysisConcurrency(''), 4);
    assert.equal(parseAnalysisConcurrency('not-a-number'), 4);
  });

  it('enforces a minimum concurrency of one', () => {
    assert.equal(parseAnalysisConcurrency('0'), 1);
    assert.equal(parseAnalysisConcurrency('-3'), 1);
  });
});
