import type { MarketProfile } from './types';

const SYMBOL_RE = /^[A-Z0-9]{1,5}\.L$/;

export const UK: MarketProfile = {
  code: 'UK',
  validateSymbol: (s) => SYMBOL_RE.test(s),
  normalizeSymbol: (s) => {
    const trimmed = s.trim().toUpperCase();
    if (SYMBOL_RE.test(trimmed)) return trimmed;
    if (/^[A-Z0-9]{1,5}$/.test(trimmed)) return `${trimmed}.L`;
    return trimmed;
  },
  providerSymbols: (s) => {
    const code = s.replace('.L', '');
    return {
      display: s,
      yahoo: s,
      bloomberg: `${code} LN Equity`,
      exchange: code,
    };
  },
  searchHints: ['LSE', 'Reuters'],
  displayCurrency: 'GBP',
  disclosureCalendar: 'UK-FCA',
};
