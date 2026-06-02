import { CN } from './cn';
import { HK } from './hk';
import { JP } from './jp';
import type { MarketProfile } from './types';
import { UK } from './uk';
import { US } from './us';

const registry = new Map<string, MarketProfile>();

/** Register or replace a market profile. */
export function registerMarket(profile: MarketProfile): void {
  registry.set(profile.code.toUpperCase(), profile);
}

/** Lookup a registered market by code (case-insensitive). */
export function getMarket(code: string): MarketProfile | undefined {
  return registry.get(code.toUpperCase());
}

/** List all registered market codes. */
export function listMarkets(): string[] {
  return Array.from(registry.keys());
}

/**
 * Detect the market for a raw symbol by trying every registered profile's
 * `validateSymbol` against the candidate's normalized form. Returns the
 * first match (registration order); undefined if no profile claims it.
 */
export function detectMarket(symbol: string): MarketProfile | undefined {
  for (const profile of registry.values()) {
    const normalized = profile.normalizeSymbol(symbol);
    if (profile.validateSymbol(normalized)) return profile;
  }
  return undefined;
}

/** Test-only: empties the registry. */
export function clearMarketRegistry(): void {
  registry.clear();
}

/** Test-only: re-register the default 5 profiles. */
export function loadDefaultMarkets(): void {
  registerMarket(US);
  registerMarket(HK);
  registerMarket(CN);
  registerMarket(JP);
  registerMarket(UK);
}

// Auto-register the 5 walking-skeleton markets on module load.
loadDefaultMarkets();
