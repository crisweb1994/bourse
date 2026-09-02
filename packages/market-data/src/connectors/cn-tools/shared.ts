import type { CnToolFetchLike } from './_fetch-headers';
import type { MarketDataToolProfile as MarketProfile } from './types';

/**
 * Shared pure helpers for the cn-tools connectors (KISS C6 remainder).
 * Previously each tool hand-copied its own defaultFetch / pick* /
 * resolveSourcePriorities; the copies had already drifted subtly
 * (unlock-calendar's pickFloat lacked the string trim/'-'/'null' handling).
 * The unified pickFloat is the superset — behavior for previously-valid
 * inputs is unchanged.
 */

export const defaultFetch: CnToolFetchLike = (url, init) =>
  globalThis.fetch(url, init) as Promise<
    ReturnType<CnToolFetchLike> extends Promise<infer T> ? T : never
  >;

/** Parse a number from Eastmoney-ish payloads: number | numeric string; ''/'-'/'null' → null. */
export function pickFloat(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const trimmed = v.trim();
    if (trimmed === '' || trimmed === '-' || trimmed === 'null') return null;
    const n = parseFloat(trimmed);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export function pickInt(v: unknown): number | null {
  const f = pickFloat(v);
  if (f === null) return null;
  return Math.round(f);
}

/** Eastmoney expresses ratios as raw percent (e.g. -3.5 → -0.035). */
export function pickDecimalFromPct(v: unknown): number | null {
  const f = pickFloat(v);
  if (f === null) return null;
  return f / 100;
}

/** Per-fact source priority from the CN market profile, with tool fallback. */
export function resolveSourcePriorities(
  profile: MarketProfile | undefined,
  fact: string,
  fallback: readonly string[] = ['eastmoney'],
): string[] {
  const fromProfile = profile?.sourcePriorities?.[fact];
  if (fromProfile && fromProfile.length > 0) return fromProfile;
  return [...fallback];
}
