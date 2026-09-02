import type { CacheEntry, CachePort } from '../ports/cache';

interface StoredEntry<T> extends CacheEntry<T> {
  expiresAt: number;
  staleUntil: number;
}

/** Small process-local cache suitable for the default self-hosted deployment. */
export class MemoryCache implements CachePort {
  private readonly entries = new Map<string, StoredEntry<unknown>>();

  constructor(
    private readonly maxEntries = 1_000,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async get<T>(key: string): Promise<CacheEntry<T> | null> {
    const entry = this.entries.get(key) as StoredEntry<T> | undefined;
    if (!entry) return null;
    const now = this.now();
    if (entry.staleUntil <= now) {
      this.entries.delete(key);
      return null;
    }
    return { value: entry.value, storedAt: entry.storedAt, stale: entry.expiresAt <= now };
  }

  async set<T>(key: string, value: T, ttlMs: number, staleTtlMs = 0): Promise<void> {
    const now = this.now();
    this.entries.set(key, {
      value,
      storedAt: new Date(now).toISOString(),
      stale: false,
      expiresAt: now + ttlMs,
      staleUntil: now + ttlMs + staleTtlMs,
    });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (!oldest) break;
      this.entries.delete(oldest);
    }
  }
}
