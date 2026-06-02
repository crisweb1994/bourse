import { describe, expect, it } from 'vitest';
import { Citation, Evidence } from '../../contracts/citation';

const validCitation = {
  title: 'Synthetic test source',
  url: 'https://example.com/test',
  sourceType: 'NEWS' as const,
  retrievedAt: '2026-01-15T10:30:00Z',
};

describe('contracts/Citation', () => {
  it('parses a minimally valid citation', () => {
    expect(Citation.parse(validCitation)).toEqual(validCitation);
  });

  it('accepts optional dimension', () => {
    const c = { ...validCitation, dimension: 'FUNDAMENTAL' as const };
    expect(Citation.parse(c).dimension).toBe('FUNDAMENTAL');
  });

  it('rejects malformed URL', () => {
    expect(() => Citation.parse({ ...validCitation, url: 'not-a-url' })).toThrow();
  });

  it('rejects unknown sourceType', () => {
    expect(() =>
      Citation.parse({ ...validCitation, sourceType: 'BLOG' }),
    ).toThrow();
  });

  it('rejects non-ISO retrievedAt', () => {
    expect(() =>
      Citation.parse({ ...validCitation, retrievedAt: '2026-01-15' }),
    ).toThrow();
  });

  it('requires title / url / sourceType / retrievedAt', () => {
    for (const missing of ['title', 'url', 'sourceType', 'retrievedAt'] as const) {
      const partial: Record<string, unknown> = { ...validCitation };
      delete partial[missing];
      expect(() => Citation.parse(partial)).toThrow();
    }
  });
});

describe('contracts/Evidence', () => {
  it('parses claim with citations array', () => {
    const e = { claim: 'Synthetic claim', citations: [validCitation] };
    expect(Evidence.parse(e)).toEqual(e);
  });

  it('allows empty citations array (guardrail enforced separately)', () => {
    const e = { claim: 'Claim with no citations', citations: [] };
    expect(Evidence.parse(e).citations).toEqual([]);
  });

  it('rejects empty claim string', () => {
    expect(() => Evidence.parse({ claim: '', citations: [] })).toThrow();
  });
});
