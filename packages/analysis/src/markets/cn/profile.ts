import { DEFAULT_CROSS_DIM_TOLERANCE } from '../../contracts/cross-dim-validator';
import type { MarketProfile } from '../types';
import { CN_DOMAIN_TIERS, CN_ENDPOINTS, CN_SOURCE_PRIORITIES } from './sources';

const SYMBOL_RE = /^\d{6}\.(SS|SZ|BJ)$/;

/**
 * Infer the suffix when only 6 digits are given:
 *   60xxxx → SS (Shanghai)
 *   00xxxx / 30xxxx → SZ (Shenzhen)
 *   8xxxxx / 4xxxxx → BJ (Beijing)
 */
function inferSuffix(digits: string): 'SS' | 'SZ' | 'BJ' {
  if (digits.startsWith('6')) return 'SS';
  if (digits.startsWith('00') || digits.startsWith('30')) return 'SZ';
  if (digits.startsWith('8') || digits.startsWith('4')) return 'BJ';
  return 'SS'; // sensible default
}

/**
 * CN (A-share) market profile.
 *
 * RFC-02: extended to carry domainTiers/endpoints/sourcePriorities so
 * v2 EvidencePack builder + tool adapters can route data fetches
 * without separately importing the sources module. Pre-RFC-02 fields
 * (symbol normalize / providerSymbols / searchHints / displayCurrency
 * / disclosureCalendar) are unchanged.
 */
export const CN: MarketProfile = {
  code: 'CN',
  validateSymbol: (s) => SYMBOL_RE.test(s),
  normalizeSymbol: (s) => {
    const trimmed = s.trim().toUpperCase();
    if (SYMBOL_RE.test(trimmed)) return trimmed;
    const digits = trimmed.replace(/\..*$/, '').replace(/\D/g, '');
    if (digits.length !== 6) return trimmed;
    return `${digits}.${inferSuffix(digits)}`;
  },
  providerSymbols: (s) => {
    const [code, suffix] = s.split('.');
    const bbgSuffix = suffix === 'SS' ? 'CH' : suffix === 'SZ' ? 'CH' : 'CG';
    return {
      display: s,
      yahoo: s,
      bloomberg: `${code} ${bbgSuffix} Equity`,
      exchange: code,
    };
  },
  searchHints: ['巨潮', '东方财富', '同花顺'],
  displayCurrency: 'CNY',
  disclosureCalendar: 'CN-CSRC',
  // RFC-02 routing config
  domainTiers: CN_DOMAIN_TIERS,
  endpoints: CN_ENDPOINTS,
  sourcePriorities: CN_SOURCE_PRIORITIES,
  // RFC-03: per-market cross-dim deviation thresholds. CN starts with
  // the validator's documented defaults; tune from telemetry once we
  // accumulate a few weeks of conflict-rate data per dim.
  crossDimTolerance: DEFAULT_CROSS_DIM_TOLERANCE,
};
