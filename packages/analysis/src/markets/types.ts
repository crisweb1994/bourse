import type { CrossDimTolerance } from '../contracts/cross-dim-validator';
import type { SourceTier } from '../contracts/evidence-pack-v2';

/**
 * Domain tier alias. Conceptually identical to `SourceTier` in
 * evidence-pack-v2 — the same A-E scale is used by (1) market profiles to
 * statically classify domains and (2) Fact<T> provenance to record the
 * realized tier per citation. Re-exported here as `DomainTier` because the
 * profile-side reading "domain tier" is clearer than "source tier".
 */
export type DomainTier = SourceTier;

/**
 * Per-market profile encapsulating symbol format, normalization, and search
 * hints. MVP doc §4.1.
 *
 * RFC-02 (Phase 1 + 1.x): added optional `domainTiers` / `endpoints` /
 * `sourcePriorities` so a market can carry the data-source routing config
 * its tools need. CN is the first market to populate them; US/HK/JP/UK
 * leave them undefined and continue to use LLM-based collection.
 */
export interface MarketProfile {
  /** Market code: 'US' | 'HK' | 'CN' | 'JP' | 'UK' (or business extension). */
  code: string;

  /** Returns true iff the symbol is a well-formed identifier for this market. */
  validateSymbol(symbol: string): boolean;

  /**
   * Normalize raw user input into the canonical form used internally.
   * Examples:
   *   - 'aapl'         → 'AAPL'      (US)
   *   - '700.hk'       → '0700.HK'   (HK leading-zero pad)
   *   - '600519'       → '600519.SS' (CN inferred suffix)
   */
  normalizeSymbol(symbol: string): string;

  /**
   * Map the canonical symbol to the formats expected by various data
   * sources. The returned `display` is what the user sees; others are
   * lookup keys for future tool integrations.
   */
  providerSymbols(symbol: string): {
    display: string;
    yahoo?: string;
    bloomberg?: string;
    exchange?: string;
  };

  /** Search-engine hints to prepend when querying for this market. */
  searchHints: readonly string[];

  /** ISO 4217 currency for displayed prices. */
  displayCurrency: string;

  /** Optional calendar tag — used by future Freshness extensions. */
  disclosureCalendar?: 'US-SEC' | 'HK-HKEX' | 'CN-CSRC' | 'JP-EDINET' | 'UK-FCA';

  /**
   * RFC-02: code-side hard-coded tier for known domains. Keys are bare
   * hostnames (e.g. 'cninfo.com.cn'). LLM-judged qualityTier per citation
   * can downgrade but cannot upgrade above this floor.
   * Undefined → market hasn't been migrated to v2 routing yet.
   */
  domainTiers?: Record<string, DomainTier>;

  /**
   * RFC-02: HTTP endpoint base URLs per source. Tool adapters read by
   * source name (e.g. profile.endpoints.eastmoney.reportapi).
   * Undefined → market hasn't been migrated to v2 routing yet.
   */
  endpoints?: Record<string, Record<string, string>>;

  /**
   * RFC-02: per-fact-field source priority list. Tool's fallback chain
   * iterates these in order. Field names match EvidencePackV2 fact keys.
   * Undefined → market hasn't been migrated to v2 routing yet.
   */
  sourcePriorities?: Record<string, string[]>;

  /**
   * RFC-03: per-market deviation thresholds for the cross-dim validator
   * (price / marketCap / pe). Each fact gets a warning/downgrade/fail
   * trio in PERCENT. Undefined → validator uses DEFAULT_CROSS_DIM_TOLERANCE.
   * Currency comparison is always exact-match (no tolerance), so it's
   * NOT part of this config.
   */
  crossDimTolerance?: CrossDimTolerance;
}
