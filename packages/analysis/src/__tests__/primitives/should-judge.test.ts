import { describe, expect, it } from 'vitest';
import type { Citation } from '../../contracts/citation';
import type { Dimension } from '../../dimensions/types';
import { shouldJudge } from '../../primitives/judge';

function dim(judgeRequired?: Dimension['judgeRequired']): Pick<Dimension, 'judgeRequired'> {
  return judgeRequired === undefined ? {} : { judgeRequired };
}

function tierCit(qualityTier: Citation['qualityTier']): Pick<Citation, 'qualityTier'> {
  return { qualityTier };
}

describe('primitives/shouldJudge (RFC-10 P1)', () => {
  it('judgeRequired=always → true regardless of signal/citations', () => {
    expect(
      shouldJudge({
        dimension: dim('always'),
        structuredJson: { conclusion: { signal: 'NEUTRAL', confidence: 'LOW' } },
        citations: [],
      }),
    ).toBe(true);
  });

  it('judgeRequired=never → false even with strong HIGH BULLISH', () => {
    expect(
      shouldJudge({
        dimension: dim('never'),
        structuredJson: { conclusion: { signal: 'BULLISH', confidence: 'HIGH' } },
        citations: [tierCit('A'), tierCit('A')],
      }),
    ).toBe(false);
  });

  it('on-strong + HIGH + BULLISH → true', () => {
    expect(
      shouldJudge({
        dimension: dim('on-strong'),
        structuredJson: { conclusion: { signal: 'BULLISH', confidence: 'HIGH' } },
        citations: [tierCit('A')],
      }),
    ).toBe(true);
  });

  it('on-strong + HIGH + BEARISH → true', () => {
    expect(
      shouldJudge({
        dimension: dim('on-strong'),
        structuredJson: { conclusion: { signal: 'BEARISH', confidence: 'HIGH' } },
        citations: [tierCit('A')],
      }),
    ).toBe(true);
  });

  it('on-strong + HIGH + NEUTRAL → false (neutral skipped even at HIGH)', () => {
    expect(
      shouldJudge({
        dimension: dim('on-strong'),
        structuredJson: { conclusion: { signal: 'NEUTRAL', confidence: 'HIGH' } },
        citations: [tierCit('A')],
      }),
    ).toBe(false);
  });

  it('on-strong + MEDIUM + BULLISH → false', () => {
    expect(
      shouldJudge({
        dimension: dim('on-strong'),
        structuredJson: { conclusion: { signal: 'BULLISH', confidence: 'MEDIUM' } },
        citations: [tierCit('A')],
      }),
    ).toBe(false);
  });

  it('Tier D/E share > 50% → true (default threshold)', () => {
    expect(
      shouldJudge({
        dimension: dim('on-strong'),
        structuredJson: { conclusion: { signal: 'NEUTRAL', confidence: 'MEDIUM' } },
        // 3 of 4 are D/E (75%)
        citations: [tierCit('A'), tierCit('D'), tierCit('D'), tierCit('E')],
      }),
    ).toBe(true);
  });

  it('Tier D/E share = exactly 50% → false (strict > threshold)', () => {
    expect(
      shouldJudge({
        dimension: dim('on-strong'),
        structuredJson: { conclusion: { signal: 'NEUTRAL', confidence: 'MEDIUM' } },
        citations: [tierCit('A'), tierCit('A'), tierCit('D'), tierCit('D')],
      }),
    ).toBe(false);
  });

  it('custom tierDeThreshold honored', () => {
    expect(
      shouldJudge({
        dimension: dim('on-strong'),
        structuredJson: { conclusion: { signal: 'NEUTRAL', confidence: 'MEDIUM' } },
        // 1 of 4 D (25%) — over a 0.2 threshold
        citations: [tierCit('A'), tierCit('A'), tierCit('A'), tierCit('D')],
        tierDeThreshold: 0.2,
      }),
    ).toBe(true);
  });

  it('cross-dim WARNING → true', () => {
    expect(
      shouldJudge({
        dimension: dim('on-strong'),
        structuredJson: { conclusion: { signal: 'NEUTRAL', confidence: 'MEDIUM' } },
        citations: [],
        crossDimSeverity: 'WARNING',
      }),
    ).toBe(true);
  });

  it('cross-dim DOWNGRADE → true', () => {
    expect(
      shouldJudge({
        dimension: dim('on-strong'),
        structuredJson: { conclusion: { signal: 'NEUTRAL', confidence: 'MEDIUM' } },
        citations: [],
        crossDimSeverity: 'DOWNGRADE',
      }),
    ).toBe(true);
  });

  it('cross-dim FAIL is NOT a judge trigger (workflow halts before judge runs)', () => {
    expect(
      shouldJudge({
        dimension: dim('on-strong'),
        structuredJson: { conclusion: { signal: 'NEUTRAL', confidence: 'MEDIUM' } },
        citations: [],
        crossDimSeverity: 'FAIL',
      }),
    ).toBe(false);
  });

  it('judgeRequired unspecified defaults to on-strong', () => {
    expect(
      shouldJudge({
        dimension: dim(),
        structuredJson: { conclusion: { signal: 'BULLISH', confidence: 'HIGH' } },
        citations: [],
      }),
    ).toBe(true);
    expect(
      shouldJudge({
        dimension: dim(),
        structuredJson: { conclusion: { signal: 'BULLISH', confidence: 'MEDIUM' } },
        citations: [],
      }),
    ).toBe(false);
  });

  it('missing conclusion / signal / confidence does not crash', () => {
    expect(
      shouldJudge({
        dimension: dim(),
        structuredJson: {},
        citations: [],
      }),
    ).toBe(false);
    expect(
      shouldJudge({
        dimension: dim(),
        structuredJson: { conclusion: {} },
        citations: [],
      }),
    ).toBe(false);
  });
});
