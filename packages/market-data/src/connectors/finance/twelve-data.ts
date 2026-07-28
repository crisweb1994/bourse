import { RESEARCH_SCHEMA_VERSION, type ResearchResult } from '../../contracts/result';
import type { ResearchWarning } from '../../contracts/warning';
import type {
  CompanyProfile,
  FinancePort,
  HistoryInput,
  PriceBar,
  ProfileInput,
  Quote,
  QuoteInput,
} from '../../ports/finance';
import { resolveFetch, withTimeout } from '../http';
import type { ConnectorRunContext, FetchLike } from '../types';
import {
  finite,
  historyFailure,
  instrumentRef,
  isoDate,
  isoEpochSeconds,
  messageOf,
  nonNegativeInteger,
  parseFinanceInstrument,
  profileFailure,
  quoteFailure,
  stringValue,
  warningCode,
  type ParsedFinanceInstrument,
} from './commercial-common';

const PROVIDER = 'twelve-data';
const BASE_URL = 'https://api.twelvedata.com';
const DEFAULT_TIMEOUT_MS = 8_000;
const SUPPORTED = new Set(['US', 'HK', 'CN'] as const);

interface TwelveError {
  status?: string;
  code?: number;
  message?: string;
}

export interface TwelveDataFinanceOptions {
  apiKey: string;
  fetchLike?: FetchLike;
  timeoutMs?: number;
  now?: () => Date;
}

export function createTwelveDataFinanceConnector(
  options: TwelveDataFinanceOptions,
): FinancePort {
  if (!options.apiKey?.trim()) throw new Error('Twelve Data connector requires apiKey.');
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = options.now ?? (() => new Date());

  return {
    async getQuote(input: QuoteInput, ctx: ConnectorRunContext = {}): Promise<ResearchResult<Quote>> {
      const retrievedAt = now().toISOString();
      const parsedResult = parseFinanceInstrument(input.instrumentId, SUPPORTED);
      if (!parsedResult.parsed) {
        return quoteFailure(PROVIDER, input.instrumentId, retrievedAt, parsedResult.code!, parsedResult.message!);
      }
      const parsed = parsedResult.parsed;
      const providerSymbol = twelveSymbol(parsed);
      if (!providerSymbol) {
        return quoteFailure(PROVIDER, input.instrumentId, retrievedAt, 'UNSUPPORTED_MARKET', `Twelve Data has no symbol mapping for ${input.instrumentId}.`);
      }
      try {
        const payload = await request('quote', { symbol: providerSymbol }, ctx, options, timeoutMs) as TwelveError & Record<string, unknown>;
        const error = apiError(payload);
        if (error) return quoteFailure(PROVIDER, input.instrumentId, retrievedAt, error.code, error.message);
        const price = finite(payload.close);
        if (price === undefined || price <= 0) {
          return quoteFailure(PROVIDER, input.instrumentId, retrievedAt, 'PARTIAL_DATA', `Twelve Data returned no usable quote for ${providerSymbol}.`);
        }
        const timestamp = isoEpochSeconds(payload.timestamp) ?? isoDate(payload.datetime) ?? retrievedAt;
        const currency = stringValue(payload.currency) ?? parsed.currency;
        const quote: Quote = {
          instrument: instrumentRef(parsed, PROVIDER, providerSymbol, stringValue(payload.exchange)),
          price,
          ...(finite(payload.change) !== undefined ? { change: finite(payload.change)! } : {}),
          ...(finite(payload.percent_change) !== undefined ? { changePct: finite(payload.percent_change)! } : {}),
          ...(finite(payload.volume) !== undefined ? { volume: finite(payload.volume)! } : {}),
          currency,
          timestamp,
          ...(finite(payload.open) !== undefined ? { dayOpen: finite(payload.open)! } : {}),
          ...(finite(payload.high) !== undefined ? { dayHigh: finite(payload.high)! } : {}),
          ...(finite(payload.low) !== undefined ? { dayLow: finite(payload.low)! } : {}),
          ...(finite(payload.previous_close) !== undefined ? { previousClose: finite(payload.previous_close)! } : {}),
        };
        return success(quote, providerSymbol, 'quote', timestamp, retrievedAt);
      } catch (error) {
        return quoteFailure(PROVIDER, input.instrumentId, retrievedAt, 'SOURCE_UNAVAILABLE', `Twelve Data quote failed: ${messageOf(error)}`);
      }
    },

    async getHistory(input: HistoryInput, ctx: ConnectorRunContext = {}): Promise<ResearchResult<PriceBar[]>> {
      const retrievedAt = now().toISOString();
      const parsedResult = parseFinanceInstrument(input.instrumentId, SUPPORTED);
      if (!parsedResult.parsed) return historyFailure(PROVIDER, retrievedAt, parsedResult.code!, parsedResult.message!);
      const providerSymbol = twelveSymbol(parsedResult.parsed);
      if (!providerSymbol) return historyFailure(PROVIDER, retrievedAt, 'UNSUPPORTED_MARKET', `Twelve Data has no symbol mapping for ${input.instrumentId}.`);
      const interval = intervalName(input.interval ?? '1d');
      try {
        const payload = await request('time_series', {
          symbol: providerSymbol,
          interval,
          start_date: input.from,
          end_date: input.to,
          outputsize: '5000',
          order: 'ASC',
        }, ctx, options, timeoutMs) as TwelveError & { values?: unknown };
        const error = apiError(payload);
        if (error) return historyFailure(PROVIDER, retrievedAt, error.code, error.message);
        const values = Array.isArray(payload.values) ? payload.values : [];
        const bars = values.flatMap(parseBar).sort((a, b) => a.timestamp.localeCompare(b.timestamp));
        if (bars.length === 0) return historyFailure(PROVIDER, retrievedAt, 'PARTIAL_DATA', `Twelve Data returned no history for ${providerSymbol}.`);
        const asOf = bars.at(-1)!.timestamp;
        return success(bars, providerSymbol, 'history', asOf, retrievedAt);
      } catch (error) {
        return historyFailure(PROVIDER, retrievedAt, 'SOURCE_UNAVAILABLE', `Twelve Data history failed: ${messageOf(error)}`);
      }
    },

    async getProfile(input: ProfileInput, ctx: ConnectorRunContext = {}): Promise<ResearchResult<CompanyProfile>> {
      const retrievedAt = now().toISOString();
      const parsedResult = parseFinanceInstrument(input.instrumentId, SUPPORTED);
      if (!parsedResult.parsed) return profileFailure(PROVIDER, input.instrumentId, retrievedAt, parsedResult.code!, parsedResult.message!);
      const parsed = parsedResult.parsed;
      const providerSymbol = twelveSymbol(parsed);
      if (!providerSymbol) return profileFailure(PROVIDER, input.instrumentId, retrievedAt, 'UNSUPPORTED_MARKET', `Twelve Data has no symbol mapping for ${input.instrumentId}.`);
      try {
        const payload = await request('profile', { symbol: providerSymbol }, ctx, options, timeoutMs) as TwelveError & Record<string, unknown>;
        const error = apiError(payload);
        if (error) return profileFailure(PROVIDER, input.instrumentId, retrievedAt, error.code, error.message);
        const description = stringValue(payload.description);
        const sector = stringValue(payload.sector);
        const industry = stringValue(payload.industry);
        const website = stringValue(payload.website);
        const employees = nonNegativeInteger(payload.employees);
        if (!description && !sector && !industry && !website && employees === undefined) {
          return profileFailure(PROVIDER, input.instrumentId, retrievedAt, 'PARTIAL_DATA', `Twelve Data returned no usable profile for ${providerSymbol}.`);
        }
        const profile: CompanyProfile = {
          instrument: instrumentRef(parsed, PROVIDER, providerSymbol, stringValue(payload.exchange)),
          ...(description ? { description } : {}),
          ...(sector ? { sector } : {}),
          ...(industry ? { industry } : {}),
          ...(website ? { website } : {}),
          ...(employees !== undefined ? { employees } : {}),
        };
        return success(profile, providerSymbol, 'profile', retrievedAt, retrievedAt);
      } catch (error) {
        return profileFailure(PROVIDER, input.instrumentId, retrievedAt, 'SOURCE_UNAVAILABLE', `Twelve Data profile failed: ${messageOf(error)}`);
      }
    },
  };
}

async function request(
  path: string,
  params: Record<string, string>,
  ctx: ConnectorRunContext,
  options: TwelveDataFinanceOptions,
  timeoutMs: number,
): Promise<unknown> {
  const query = new URLSearchParams({ ...params, apikey: options.apiKey.trim() });
  const fetchLike = resolveFetch(ctx, options);
  return withTimeout(ctx, ctx.timeoutMs ?? timeoutMs, async (signal) => {
    const response = await fetchLike(`${BASE_URL}/${path}?${query.toString()}`, {
      headers: { Accept: 'application/json' },
      signal,
    });
    const payload = await response.json() as TwelveError;
    if (!response.ok) {
      return {
        ...payload,
        status: 'error',
        code: response.status,
        message: payload.message ?? `HTTP ${response.status}`,
      };
    }
    return payload;
  });
}

function apiError(payload: TwelveError): { code: ResearchWarning['code']; message: string } | null {
  if (payload.status !== 'error' && payload.code === undefined) return null;
  const message = payload.message ?? 'Twelve Data API error.';
  return { code: warningCode(payload.code, message), message };
}

function twelveSymbol(parsed: ParsedFinanceInstrument): string | null {
  if (parsed.market === 'US') return parsed.symbol.toUpperCase();
  if (parsed.market === 'HK') {
    const digits = parsed.symbol.replace(/\.HK$/i, '');
    const code = /^\d+$/.test(digits) ? digits.padStart(4, '0').slice(-4) : digits;
    return `${code}:HKEX`;
  }
  if (/^(5|6|9)/.test(parsed.symbol)) return `${parsed.symbol}:SSE`;
  if (/^(0|1|2|3)/.test(parsed.symbol)) return `${parsed.symbol}:SZSE`;
  return null;
}

function intervalName(interval: NonNullable<HistoryInput['interval']>): string {
  return interval === '1d' ? '1day' : interval === '1h' ? '1h' : interval === '5m' ? '5min' : '1min';
}

function parseBar(value: unknown): PriceBar[] {
  if (!value || typeof value !== 'object') return [];
  const row = value as Record<string, unknown>;
  const timestamp = typeof row.datetime === 'string' ? row.datetime : undefined;
  const open = finite(row.open);
  const high = finite(row.high);
  const low = finite(row.low);
  const close = finite(row.close);
  if (!timestamp || open === undefined || high === undefined || low === undefined || close === undefined) return [];
  return [{ timestamp, open, high, low, close, ...(finite(row.volume) !== undefined ? { volume: finite(row.volume)! } : {}) }];
}

function success<T>(
  data: T,
  symbol: string,
  kind: 'quote' | 'history' | 'profile',
  asOf: string,
  retrievedAt: string,
): ResearchResult<T> {
  return {
    schemaVersion: RESEARCH_SCHEMA_VERSION,
    data,
    citations: [{
      title: `Twelve Data ${kind}: ${symbol}`,
      url: `https://twelvedata.com/markets/${encodeURIComponent(symbol)}`,
      sourceType: kind === 'profile' ? 'OTHER' : 'PRICE',
      provider: PROVIDER,
      retrievedAt,
      qualityTier: 'B',
    }],
    freshness: [{ provider: PROVIDER, asOf, retrievedAt, stale: false }],
    warnings: [],
  };
}
