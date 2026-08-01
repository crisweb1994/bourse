import { describe, expect, it } from 'vitest';
import { MemoryCache } from './memory-cache';

describe('MemoryCache', () => {
  it('transitions from fresh to stale and then expires the entry', async () => {
    let now = 0;
    const cache = new MemoryCache(10, () => now);
    await cache.set('quote', { price: 100 }, 10, 20);

    expect(await cache.get('quote')).toEqual(expect.objectContaining({ stale: false }));
    now = 10;
    expect(await cache.get('quote')).toEqual(expect.objectContaining({ stale: true }));
    now = 30;
    expect(await cache.get('quote')).toBeNull();
  });
});
