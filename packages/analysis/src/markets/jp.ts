import type { MarketProfile } from './types';

const SYMBOL_RE = /^\d{4}\.T$/;

export const JP: MarketProfile = {
  code: 'JP',
  validateSymbol: (s) => SYMBOL_RE.test(s),
  normalizeSymbol: (s) => {
    const trimmed = s.trim().toUpperCase();
    if (SYMBOL_RE.test(trimmed)) return trimmed;
    const digits = trimmed.replace(/\..*$/, '').replace(/\D/g, '');
    if (digits.length !== 4) return trimmed;
    return `${digits}.T`;
  },
  providerSymbols: (s) => {
    const code = s.replace('.T', '');
    return {
      display: s,
      yahoo: s,
      bloomberg: `${code} JP Equity`,
      exchange: code,
    };
  },
  searchHints: ['JPX', '日経'],
  displayCurrency: 'JPY',
  disclosureCalendar: 'JP-EDINET',
};
