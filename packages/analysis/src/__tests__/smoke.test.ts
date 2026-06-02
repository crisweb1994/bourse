import { describe, expect, it } from 'vitest';
import { VERSION } from '../index';

describe('@bourse/analysis smoke', () => {
  it('package exports VERSION constant', () => {
    expect(VERSION).toBe('0.1.0');
  });
});
