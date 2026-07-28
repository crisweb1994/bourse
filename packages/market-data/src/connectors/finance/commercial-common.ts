import type { InstrumentRef, MarketCode } from '../../contracts/instrument';
import type { ResearchResult } from '../../contracts/result';
import type { ResearchWarning } from '../../contracts/warning';
import type { CompanyProfile, PriceBar, Quote } from '../../ports/finance';
import { parseInstrumentId } from '../../util/instrument-id';
import { failure as httpFailure } from '../http';

const CURRENCY_BY_MARKET: Record<MarketCode, string> = {
  US: 'USD',
  HK: 'HKD',
  CN: 'CNY',
  JP: 'JPY',
  UK: 'GBP',
};

export interface ParsedFinanceInstrument {
  instrumentId: string;
  market: MarketCode;
  symbol: string;
  currency: string;
}

export function parseFinanceInstrument(
  instrumentId: string,
  supported: ReadonlySet<MarketCode>,
): { parsed?: ParsedFinanceInstrument; code?: ResearchWarning['code']; message?: string } {
  const value = parseInstrumentId(instrumentId);
  if (!value) return { code: 'INVALID_INSTRUMENT', message: `Invalid instrumentId: ${instrumentId}` };
  if (!supported.has(value.market)) {
    return { code: 'UNSUPPORTED_MARKET', message: `Provider does not support market ${value.market}.` };
  }
  return {
    parsed: {
      instrumentId: value.raw,
      market: value.market,
      symbol: value.symbol,
      currency: CURRENCY_BY_MARKET[value.market],
    },
  };
}

export function instrumentRef(
  parsed: ParsedFinanceInstrument,
  provider: string,
  providerSymbol: string,
  exchange?: string,
): InstrumentRef {
  return {
    instrumentId: parsed.instrumentId,
    market: parsed.market,
    symbol: parsed.symbol,
    currency: parsed.currency,
    ...(exchange ? { exchange } : {}),
    providerSymbols: { [provider]: providerSymbol },
  };
}

export function finite(value: unknown): number | undefined {
  if (typeof value !== 'number' && typeof value !== 'string') return undefined;
  const number = Number(typeof value === 'string' ? value.replace(/[%,$]/g, '').trim() : value);
  return Number.isFinite(number) ? number : undefined;
}

export function nonNegativeInteger(value: unknown): number | undefined {
  const number = finite(value);
  return number !== undefined && number >= 0 ? Math.trunc(number) : undefined;
}

export function stringValue(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed && trimmed !== '-' && trimmed.toLowerCase() !== 'null' ? trimmed : undefined;
}

export function isoDate(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return `${trimmed}T00:00:00.000Z`;
  const time = Date.parse(trimmed);
  return Number.isNaN(time) ? undefined : new Date(time).toISOString();
}

export function isoEpochSeconds(value: unknown): string | undefined {
  const seconds = finite(value);
  if (seconds === undefined || seconds <= 0) return undefined;
  const time = seconds * 1000;
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
}

export function warningCode(
  status?: number,
  message = '',
): ResearchWarning['code'] {
  if (status === 401 || status === 403 || /api.?key|token|auth|forbidden|premium/i.test(message)) {
    return 'AUTH_REQUIRED';
  }
  if (status === 429 || /rate|frequency|too many|limit exceeded/i.test(message)) {
    return 'RATE_LIMITED';
  }
  return 'SOURCE_UNAVAILABLE';
}

export function quoteFailure(
  provider: string,
  instrumentId: string,
  retrievedAt: string,
  code: ResearchWarning['code'],
  message: string,
): ResearchResult<Quote> {
  const parsed = parseInstrumentId(instrumentId);
  return httpFailure(provider, {
    instrument: {
      instrumentId: parsed?.raw ?? instrumentId,
      market: parsed?.market ?? 'US',
      symbol: parsed?.symbol ?? instrumentId.split(':').at(-1) ?? instrumentId,
    },
    price: Number.NaN,
    currency: parsed ? CURRENCY_BY_MARKET[parsed.market] : 'USD',
    timestamp: new Date(0).toISOString(),
  }, { retrievedAt, code, message });
}

export function historyFailure(
  provider: string,
  retrievedAt: string,
  code: ResearchWarning['code'],
  message: string,
): ResearchResult<PriceBar[]> {
  return httpFailure(provider, [], { retrievedAt, code, message });
}

export function profileFailure(
  provider: string,
  instrumentId: string,
  retrievedAt: string,
  code: ResearchWarning['code'],
  message: string,
): ResearchResult<CompanyProfile> {
  const parsed = parseInstrumentId(instrumentId);
  return httpFailure(provider, {
    instrument: {
      instrumentId: parsed?.raw ?? instrumentId,
      market: parsed?.market ?? 'US',
      symbol: parsed?.symbol ?? instrumentId.split(':').at(-1) ?? instrumentId,
    },
  }, { retrievedAt, code, message });
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message || error.name : String(error);
}
