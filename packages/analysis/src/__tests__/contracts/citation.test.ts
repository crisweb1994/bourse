import { describe, expect, it } from 'vitest';
import { Citation, Evidence } from '../../contracts/citation';

const valid = {
  title: 'Source',
  url: 'https://example.com/source',
  sourceType: 'DATA_PROVIDER' as const,
  retrievedAt: '2026-01-15T10:30:00.000Z',
};

describe('Citation V2', () => {
  it('requires source type and retrieval time', () => {
    expect(Citation.parse(valid)).toEqual(valid);
    expect(() => Citation.parse({ ...valid, sourceType: 'BLOG' })).toThrow();
    expect(() => Citation.parse({ ...valid, retrievedAt: '2026-01-15' })).toThrow();
  });

  it('allows evidence with an empty citation list for a limitation', () => {
    expect(Evidence.parse({ claim: 'Not enough data', citations: [] }).claim).toBe('Not enough data');
  });
});
