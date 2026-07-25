/**
 * plan-v2 Wave 0 — eval barrel.
 *
 * Exports the judge + types so test runners (and apps/api smoke
 * scripts) can call them without depth-3 paths.
 */

export {
  hashRawFixture,
  judgeFixture,
  lockExpected,
  replayCompute,
} from './judge';

export {
  FixtureMetaSchema,
  NUMERIC_TOLERANCE,
  type ExpectedComputedFacts,
  type ExpectedFixture,
  type FixtureId,
  type FixtureMeta,
  type JudgeRunResult,
  type RawFixture,
} from './types';

export * from './earnings';
