import type { ConnectorRunContext, FetchLike } from '../types';
import { resolveFetch } from '../http';

/**
 * SEC EDGAR identifies issuers by CIK (Central Index Key), not ticker.
 * The mapping table at https://www.sec.gov/files/company_tickers.json is
 * ~6MB and refreshed nightly. We cache it in process memory.
 */

const TICKERS_URL = 'https://www.sec.gov/files/company_tickers.json';
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

interface TickerEntry {
  cik_str: number;
  ticker: string;
  title: string;
}

/** Strict CIK + name pair returned to callers. */
export interface CikRecord {
  cik: string; // 10-digit zero-padded form
  name: string;
}

export interface CikLookup {
  /** Resolve a US ticker (case-insensitive) to a SEC CIK. */
  resolve(ticker: string, ctx?: ConnectorRunContext): Promise<CikRecord | null>;
}

export interface CikLookupOptions {
  userAgent: string;
  fetchLike?: FetchLike;
  ttlMs?: number;
  now?: () => number;
}

export function createInMemoryCikLookup(options: CikLookupOptions): CikLookup {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const now = options.now ?? Date.now;
  let cache: { byTicker: Map<string, CikRecord>; loadedAt: number } | null = null;
  let inflight: Promise<Map<string, CikRecord>> | null = null;

  return {
    async resolve(ticker: string, ctx?: ConnectorRunContext): Promise<CikRecord | null> {
      const key = ticker.trim().toUpperCase();
      if (!key) return null;
      const table = await getTable(ctx);
      return table.get(key) ?? null;
    },
  };

  async function getTable(ctx?: ConnectorRunContext): Promise<Map<string, CikRecord>> {
    if (cache && now() - cache.loadedAt < ttlMs) return cache.byTicker;
    if (inflight) return inflight;
    inflight = loadTable(ctx).finally(() => {
      inflight = null;
    });
    const byTicker = await inflight;
    cache = { byTicker, loadedAt: now() };
    return byTicker;
  }

  async function loadTable(ctx?: ConnectorRunContext): Promise<Map<string, CikRecord>> {
    const fetchLike = resolveFetch(ctx ?? {}, options);
    const res = await fetchLike(TICKERS_URL, {
      headers: { 'User-Agent': options.userAgent },
      ...(ctx?.signal ? { signal: ctx.signal } : {}),
    });
    if (!res.ok) {
      throw new Error(`SEC ticker table HTTP ${res.status}`);
    }
    const raw = (await res.json()) as Record<string, TickerEntry>;
    const map = new Map<string, CikRecord>();
    for (const entry of Object.values(raw)) {
      if (!entry?.ticker || !entry.cik_str) continue;
      const key = entry.ticker.toUpperCase();
      const cik = String(entry.cik_str).padStart(10, '0');
      map.set(key, { cik, name: entry.title });
    }
    return map;
  }
}
