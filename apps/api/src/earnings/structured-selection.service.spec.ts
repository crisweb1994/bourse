import test from 'node:test';
import assert from 'node:assert/strict';
import { stableHash } from './structured-selection.service';

test('stableHash is key-order independent', () => {
  assert.equal(
    stableHash({ a: 1, b: { c: 2, d: [1, 2] } }),
    stableHash({ b: { d: [1, 2], c: 2 }, a: 1 }),
  );
});
