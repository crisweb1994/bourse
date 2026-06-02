import { describe, expect, it } from 'vitest';
import { computeContentHash } from './content-hash';

describe('computeContentHash', () => {
  it('produces stable hash for normalized content', () => {
    const a = computeContentHash({ markdown: 'Hello   World' });
    const b = computeContentHash({ markdown: 'hello world' });
    expect(a).toBe(b);
  });

  it('dedupes across providers via same canonical content', () => {
    const a = computeContentHash({ markdown: 'Nvidia beats Q1 estimates' });
    const b = computeContentHash({ text: 'NVIDIA beats Q1 estimates' });
    expect(a).toBe(b);
  });

  it('throws when all inputs empty', () => {
    expect(() => computeContentHash({})).toThrow();
  });

  it('falls back to canonicalUrl when no body', () => {
    const h = computeContentHash({ canonicalUrl: 'https://example.com/a' });
    expect(h).toHaveLength(64);
  });
});
