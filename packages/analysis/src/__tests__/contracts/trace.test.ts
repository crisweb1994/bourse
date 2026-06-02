import { describe, expect, it } from 'vitest';
import { PerDimensionTrace, Trace } from '../../contracts/trace';

const validTrace = {
  llmCalls: 3,
  toolCalls: 7,
  tokensIn: 1500,
  tokensOut: 800,
  totalUsd: 0.125,
  durationMs: 4321,
};

describe('contracts/Trace', () => {
  it('parses a minimal trace without perDimension', () => {
    expect(Trace.parse(validTrace)).toEqual(validTrace);
  });

  it('parses trace with perDimension breakdown', () => {
    const withDims = {
      ...validTrace,
      perDimension: {
        FUNDAMENTAL: {
          durationMs: 1000,
          citationsCount: 5,
          tokensIn: 500,
          tokensOut: 200,
        },
      },
    };
    expect(Trace.parse(withDims).perDimension?.FUNDAMENTAL?.tokensIn).toBe(500);
  });

  it('rejects negative numbers', () => {
    expect(() => Trace.parse({ ...validTrace, tokensIn: -1 })).toThrow();
    expect(() => Trace.parse({ ...validTrace, totalUsd: -0.01 })).toThrow();
  });

  it('rejects non-integer where int required', () => {
    expect(() => Trace.parse({ ...validTrace, llmCalls: 3.5 })).toThrow();
  });

  it('rejects unknown dimension key in perDimension', () => {
    expect(() =>
      Trace.parse({
        ...validTrace,
        perDimension: {
          NOT_A_DIMENSION: {
            durationMs: 0,
            citationsCount: 0,
            tokensIn: 0,
            tokensOut: 0,
          },
        },
      }),
    ).toThrow();
  });
});

describe('contracts/PerDimensionTrace', () => {
  it('requires all 4 metric fields', () => {
    expect(() => PerDimensionTrace.parse({ durationMs: 100 })).toThrow();
  });
});
