import type { MarketProfile } from './types';

const SYMBOL_RE = /^\d{4,5}\.HK$/;
// Inputs that this profile is willing to claim. Avoids stealing JP's
// `7203.T` or CN's `600519.SS` during auto-detect.
const CLAIMABLE_RE = /^\d{1,5}(\.HK)?$/i;

export const HK: MarketProfile = {
  code: 'HK',
  validateSymbol: (s) => SYMBOL_RE.test(s),
  normalizeSymbol: (s) => {
    const trimmed = s.trim().toUpperCase();
    if (SYMBOL_RE.test(trimmed)) return trimmed;
    if (!CLAIMABLE_RE.test(trimmed)) return trimmed;
    const digits = trimmed.replace(/\.HK$/, '').replace(/\D/g, '');
    if (!digits) return trimmed;
    return `${digits.padStart(4, '0')}.HK`;
  },
  providerSymbols: (s) => {
    const digits = s.replace('.HK', '');
    const trimmed = digits.replace(/^0+/, '') || '0';
    return {
      display: s,
      yahoo: s,
      bloomberg: `${trimmed} HK Equity`,
      exchange: digits,
    };
  },
  searchHints: ['HKEX', '巨潮', '财华社'],
  displayCurrency: 'HKD',
  disclosureCalendar: 'HK-HKEX',
};
