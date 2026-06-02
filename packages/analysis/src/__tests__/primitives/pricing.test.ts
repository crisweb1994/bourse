import { describe, expect, it } from 'vitest';
import { computeUsd, getPricing } from '../../primitives/pricing';

describe('primitives/getPricing', () => {
  it('returns Sonnet 4 rates for canonical id', () => {
    expect(getPricing('claude-sonnet-4-20250514')).toEqual({
      inputPerMTok: 3,
      outputPerMTok: 15,
    });
  });

  it('returns Haiku 4.5 rates for canonical id', () => {
    expect(getPricing('claude-haiku-4-5-20251001')).toEqual({
      inputPerMTok: 1,
      outputPerMTok: 5,
    });
  });

  it('returns Opus 4 rates for canonical id', () => {
    expect(getPricing('claude-opus-4-20250514')).toEqual({
      inputPerMTok: 15,
      outputPerMTok: 75,
    });
  });

  it('falls back to Sonnet rates for unknown model', () => {
    expect(getPricing('claude-foo-9000')).toEqual({
      inputPerMTok: 3,
      outputPerMTok: 15,
    });
  });

  it('falls back when model is undefined', () => {
    expect(getPricing(undefined)).toEqual({ inputPerMTok: 3, outputPerMTok: 15 });
  });
});

describe('primitives/computeUsd', () => {
  it('1M sonnet input tokens cost $3', () => {
    expect(computeUsd('claude-sonnet-4-20250514', 1_000_000, 0)).toBeCloseTo(3, 5);
  });

  it('1M sonnet output tokens cost $15', () => {
    expect(computeUsd('claude-sonnet-4-20250514', 0, 1_000_000)).toBeCloseTo(15, 5);
  });

  it('1M haiku input + 1M output cost $6 total', () => {
    expect(computeUsd('claude-haiku-4-5-20251001', 1_000_000, 1_000_000)).toBeCloseTo(6, 5);
  });

  it('returns 0 for zero usage', () => {
    expect(computeUsd('claude-sonnet-4-20250514', 0, 0)).toBe(0);
  });
});
