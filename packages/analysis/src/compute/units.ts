/**
 * Unit normalization for compute layer.
 *
 * Background: connector outputs use heterogeneous units —
 *  - SEC EDGAR XBRL: base currency unit (USD)
 *  - Eastmoney datacenter: typically 元 (CNY), but some fields are 万元
 *  - Yahoo Finance: base currency, mixed currency for HK ADRs
 *
 * Compute layer requires all monetary values in **base currency unit**
 * (USD / CNY / HKD), no thousands / millions / 万元 scaling.
 *
 * This module is the single chokepoint for unit conversion.
 */

import type { ComputeWarning } from './types';

// ----------------------------------------------------------------------------
// Unit recognition
// ----------------------------------------------------------------------------

/**
 * Multiplier from a given unit string to the base currency unit (1.0 = base).
 *
 * Returns null when the unit string is unrecognized — caller must surface
 * a `unknown_unit` warning and treat the value as untrusted.
 */
export function unitMultiplier(unit: string): number | null {
  const u = unit.trim().toLowerCase();

  // Base currency units — recognized as 1.0
  if (
    u === 'usd' ||
    u === 'cny' ||
    u === 'rmb' ||
    u === 'hkd' ||
    u === '元' ||
    u === '人民币元' ||
    u === '美元' ||
    u === '港元'
  ) {
    return 1;
  }

  // Eastmoney common scaling
  if (u === '万元' || u === '万' || u === 'wan' || u === 'ten_thousand') {
    return 10_000;
  }
  if (u === '亿元' || u === '亿' || u === 'yi' || u === 'hundred_million') {
    return 100_000_000;
  }

  // Anglo scaling sometimes seen in scraped data
  if (u === 'thousands' || u === 'k') return 1_000;
  if (u === 'millions' || u === 'm' || u === 'mn') return 1_000_000;
  if (u === 'billions' || u === 'bn' || u === 'b') return 1_000_000_000;

  // Per-share / ratio units — pass through as 1
  if (u === 'usd/shares' || u === 'cny/shares' || u === 'hkd/shares') return 1;
  if (u === 'pure' || u === 'ratio' || u === 'percent' || u === '%') return 1;
  if (u === 'shares' || u === 'share') return 1;

  return null;
}

/**
 * Convert a numeric value to its base-unit equivalent given a unit string.
 *
 * Returns `{ value: null, warning }` when unit is unrecognized.
 * Returns `{ value, warning: null }` on success.
 */
export function normalize(
  raw: number | null | undefined,
  unit: string,
  metric: string,
): { value: number | null; warning: ComputeWarning | null } {
  if (raw === null || raw === undefined || Number.isNaN(raw)) {
    return { value: null, warning: null };
  }

  const mult = unitMultiplier(unit);
  if (mult === null) {
    return {
      value: null,
      warning: {
        code: 'unknown_unit',
        metric,
        detail: `Unrecognized unit '${unit}' for ${metric}`,
      },
    };
  }

  return { value: raw * mult, warning: null };
}

// ----------------------------------------------------------------------------
// Currency code normalization
// ----------------------------------------------------------------------------

const CURRENCY_ALIASES: Record<string, 'USD' | 'CNY' | 'HKD'> = {
  USD: 'USD',
  CNY: 'CNY',
  RMB: 'CNY',
  HKD: 'HKD',
};

/**
 * Normalize a currency string (ISO 4217 or vernacular alias) to the canonical
 * base currency enum used by compute layer.
 */
export function normalizeCurrency(
  currency: string,
): 'USD' | 'CNY' | 'HKD' | null {
  return CURRENCY_ALIASES[currency.toUpperCase()] ?? null;
}

/**
 * Derive base currency from a market code. Used when the connector did not
 * stamp `currency` on the bundle (defensive fallback).
 */
export function currencyForMarket(market: string): 'USD' | 'CNY' | 'HKD' {
  const m = market.toUpperCase();
  if (m === 'CN') return 'CNY';
  if (m === 'HK') return 'HKD';
  return 'USD';
}
