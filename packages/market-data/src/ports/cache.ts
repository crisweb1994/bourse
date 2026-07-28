/** B1: short-TTL transient cache layer for connector results. */
export interface CacheEntry<T> {
  value: T;
  storedAt: string;
  stale: boolean;
}

export interface CachePort {
  get<T>(key: string): Promise<CacheEntry<T> | null>;
  set<T>(key: string, value: T, ttlMs: number): Promise<void>;
  invalidate(prefix: string): Promise<void>;
}
