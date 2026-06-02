import { createHash } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';

/**
 * plan-v2 Wave 4.3 — in-memory LRU tool cache.
 *
 * Replaces the Postgres-backed `ToolResultCache` table. plan-v2 §15.1
 * decision: SnapshotV2 fetches are short-lived per request; cross-
 * request caching value is small and the table created maintenance
 * overhead (schema, GC, hit-count writes). In-memory LRU per process
 * is sufficient for the SnapshotCache role new code needs.
 *
 * Failure policy unchanged: get returns null on absence, set is best-
 * effort.
 */

export interface ToolCacheKey {
  toolName: string;
  market: string;
  symbol: string;
  args?: unknown;
}

interface CacheEntry {
  payload: unknown;
  expiresAt: number;
}

const DEFAULT_MAX_ENTRIES = 5000;

@Injectable()
export class ToolCacheService {
  private readonly logger = new Logger(ToolCacheService.name);
  private readonly store = new Map<string, CacheEntry>();
  private readonly maxEntries: number;

  constructor() {
    this.maxEntries = Number(process.env.TOOL_CACHE_MAX_ENTRIES) || DEFAULT_MAX_ENTRIES;
  }

  async get(key: ToolCacheKey): Promise<unknown | null> {
    const cacheKey = this.deriveCacheKey(key);
    const entry = this.store.get(cacheKey);
    if (!entry) return null;
    if (entry.expiresAt < Date.now()) {
      this.store.delete(cacheKey);
      return null;
    }
    // LRU bump: re-insert to move to end of iteration order
    this.store.delete(cacheKey);
    this.store.set(cacheKey, entry);
    return entry.payload;
  }

  async set(key: ToolCacheKey, payload: unknown, ttlMs: number): Promise<void> {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) return;
    const cacheKey = this.deriveCacheKey(key);
    this.store.set(cacheKey, {
      payload,
      expiresAt: Date.now() + ttlMs,
    });
    if (this.store.size > this.maxEntries) {
      const first = this.store.keys().next().value;
      if (first !== undefined) this.store.delete(first);
    }
  }

  private deriveCacheKey(key: ToolCacheKey): string {
    const argsHash = key.args
      ? createHash('sha256').update(canonicalJson(key.args)).digest('hex').slice(0, 16)
      : 'noargs';
    return `${key.toolName}:${key.market}:${key.symbol}:${argsHash}`;
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts = keys.map(
    (k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`,
  );
  return `{${parts.join(',')}}`;
}
