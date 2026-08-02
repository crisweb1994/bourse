import { describe, expect, it } from 'vitest';
import { locateSourceSpan } from '../earnings-verify';

describe('locateSourceSpan', () => {
  it('rejects an ambiguous quote and accepts a page-qualified match', () => {
    const repeated = 'Revenue was 10.\nRevenue was 10.';
    expect(locateSourceSpan(repeated, 'Revenue was 10.')).toBeNull();
    expect(
      locateSourceSpan(repeated, 'Revenue was 10.', 2, [
        { page: 1, startOffset: 0, endOffset: 16 },
        { page: 2, startOffset: 16, endOffset: repeated.length },
      ]),
    ).toEqual({
      quote: 'Revenue was 10.',
      startOffset: 16,
      endOffset: 31,
      page: 2,
    });
  });

  it('returns the original source offsets after whitespace normalization', () => {
    const text = 'Revenue\twas\n10.';
    expect(locateSourceSpan(text, 'revenue was 10.')).toEqual({
      quote: text,
      startOffset: 0,
      endOffset: text.length,
    });
  });
});
