import type { CachePort } from '../ports/cache';
import { RESEARCH_SCHEMA_VERSION } from '../contracts/result';

export function inMemoryCache(): CachePort {
  const store = new Map<string, { value: unknown; expiresAt: number; storedAt: string }>();
  return {
    async get(key) {
      const entry = store.get(key);
      if (!entry) return null;
      const stale = Date.now() > entry.expiresAt;
      return { value: entry.value as never, storedAt: entry.storedAt, stale };
    },
    async set(key, value, ttlMs) {
      store.set(key, {
        value,
        expiresAt: Date.now() + ttlMs,
        storedAt: new Date().toISOString(),
      });
    },
    async invalidate(prefix) {
      for (const k of store.keys()) if (k.startsWith(prefix)) store.delete(k);
    },
  };
}

export const FAKE_RESEARCH_SCHEMA_VERSION = RESEARCH_SCHEMA_VERSION;
