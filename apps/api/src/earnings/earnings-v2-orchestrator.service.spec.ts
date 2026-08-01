import test from 'node:test';
import assert from 'node:assert/strict';
import { buildNarrativeDerivationKey } from './earnings-v2-orchestrator.service';

const base = {
  filingId: 'filing-1',
  parserDerivationId: 'derivation-1',
  sourceHash: 'a'.repeat(64),
  model: 'claude-4',
};

test('buildNarrativeDerivationKey is stable for identical inputs', () => {
  assert.equal(
    buildNarrativeDerivationKey(base),
    buildNarrativeDerivationKey({ ...base }),
  );
});

test('buildNarrativeDerivationKey changes with model or source hash', () => {
  const changedModel = buildNarrativeDerivationKey({ ...base, model: 'gpt-5' });
  const changedHash = buildNarrativeDerivationKey({
    ...base,
    sourceHash: 'b'.repeat(64),
  });
  assert.notEqual(changedModel, buildNarrativeDerivationKey(base));
  assert.notEqual(changedHash, buildNarrativeDerivationKey(base));
});

test('buildNarrativeDerivationKey is distinct from the legacy extraction key', () => {
  // 使用相同的输入结构但不同 schema/prompt 版本（legacy key 由 runner 生成）。
  const legacy = require('crypto')
    .createHash('sha256')
    .update(
      JSON.stringify({
        ...base,
        promptVersion: 'earnings-extraction-v3',
        schemaVersion: 'earnings-card-v2',
      }),
    )
    .digest('hex');
  assert.notEqual(buildNarrativeDerivationKey(base), legacy);
});
