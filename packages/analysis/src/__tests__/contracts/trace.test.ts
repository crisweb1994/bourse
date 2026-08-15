import { describe, expect, it } from 'vitest';
import { Trace } from '../../contracts/trace';

describe('Trace V2', () => {
  it('accepts trace entries keyed by the five section types', () => {
    const parsed = Trace.parse({
      llmCalls: 2,
      toolCalls: 1,
      tokensIn: 10,
      tokensOut: 20,
      durationMs: 30,
      perDimension: {
        COMPANY_QUALITY: {
          durationMs: 1, citationsCount: 1, tokensIn: 5, tokensOut: 5,
        },
      },
    });
    expect(parsed.perDimension?.COMPANY_QUALITY?.tokensOut).toBe(5);
  });

  it('rejects legacy dimension keys', () => {
    expect(() => Trace.parse({
      llmCalls: 0, toolCalls: 0, tokensIn: 0, tokensOut: 0, durationMs: 0,
      perDimension: { FUNDAMENTAL: { durationMs: 0, citationsCount: 0, tokensIn: 0, tokensOut: 0 } },
    })).toThrow();
  });
});
