import type { MarketProfile } from './types';

// Class suffixes restricted to A-K so US doesn't accidentally claim
// UK's .L, JP's .T, HK's .HK, CN's .SS/.SZ/.BJ during auto-detect.
const SYMBOL_RE = /^[A-Z]{1,5}(\.[A-K])?$/;

export const US: MarketProfile = {
  code: 'US',
  validateSymbol: (s) => SYMBOL_RE.test(s),
  normalizeSymbol: (s) => s.trim().toUpperCase(),
  providerSymbols: (s) => ({
    display: s,
    yahoo: s,
    bloomberg: `${s.replace('.', '/')} US Equity`,
    exchange: s,
  }),
  searchHints: ['SEC EDGAR', 'Yahoo Finance', 'Bloomberg'],
  displayCurrency: 'USD',
  disclosureCalendar: 'US-SEC',
};
