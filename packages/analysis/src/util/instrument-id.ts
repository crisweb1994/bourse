import { MarketCode } from '../contracts/instrument';

const INSTRUMENT_ID_RE = /^([A-Z]{2}):([A-Za-z0-9.\-_]+)$/;

/** Parses Yahoo-style suffixed symbols to a MarketCode hint. */
const YAHOO_SUFFIX_TO_MARKET: Record<string, MarketCode> = {
  HK: 'HK',
  SS: 'CN',
  SZ: 'CN',
  T: 'JP',
  L: 'UK',
};

export interface ParsedInstrumentId {
  market: MarketCode;
  symbol: string;
  raw: string;
}

/**
 * Parse a canonical `MARKET:SYMBOL` string into market + symbol.
 *
 * Tolerant of surrounding whitespace and lowercase market code.
 * Symbol case is preserved (some markets are case-sensitive in display).
 * Returns null on any invalid input — callers must handle it.
 */
export function parseInstrumentId(input: unknown): ParsedInstrumentId | null {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (!trimmed) return null;

  const upper = trimmed.toUpperCase();
  const m = INSTRUMENT_ID_RE.exec(upper);
  if (!m) return null;

  const [, marketRaw, symbolUpper] = m;
  const market = MarketCode.safeParse(marketRaw);
  if (!market.success) return null;

  // Preserve original symbol casing rather than the uppercased version.
  const colonIdx = trimmed.indexOf(':');
  const symbol = trimmed.slice(colonIdx + 1).trim();
  if (!symbol) return null;

  return { market: market.data, symbol, raw: `${market.data}:${symbol}` };
}

/** Strict format check; no normalization. */
export function isInstrumentIdFormat(input: unknown): boolean {
  if (typeof input !== 'string') return false;
  return INSTRUMENT_ID_RE.test(input);
}

/** Canonical concatenation. Does NOT validate market beyond enum check. */
export function formatInstrumentId(market: MarketCode, symbol: string): string {
  const s = symbol.trim();
  if (!s) throw new Error('formatInstrumentId: symbol is empty');
  return `${market}:${s}`;
}

export interface ParsedProviderSymbol {
  market: MarketCode;
  symbol: string;
  source: 'yahoo-suffix';
}

/**
 * Recognize Yahoo-style suffixed symbols (`0700.HK`, `600519.SS`, `7203.T`,
 * `BARC.L`). Returns null when no known suffix matches — does NOT guess US
 * from a bare symbol, since that would create false positives for free-text
 * queries like "NVDA" vs "AAPL News".
 */
export function parseYahooSymbol(input: unknown): ParsedProviderSymbol | null {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (!trimmed.includes('.')) return null;

  const lastDot = trimmed.lastIndexOf('.');
  const head = trimmed.slice(0, lastDot);
  const tail = trimmed.slice(lastDot + 1).toUpperCase();
  if (!head || !tail) return null;

  const market = YAHOO_SUFFIX_TO_MARKET[tail];
  if (!market) return null;

  // Canonical HK is 5-digit (HKEx). Yahoo sometimes hands us 4-digit
  // (`0700.HK`); pad to 5 so the canonical instrumentId matches PRD.
  const symbol = market === 'HK' && /^\d{4}$/.test(head) ? `0${head}` : head;
  return { market, symbol, source: 'yahoo-suffix' };
}
