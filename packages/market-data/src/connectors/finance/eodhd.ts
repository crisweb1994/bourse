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

const PROVIDER = 'eodhd';
const BASE_URL = 'https://eodhd.com/api';
const DEFAULT_TIMEOUT_MS = 10_000;
const SUPPORTED = new Set(['US', 'HK', 'CN'] as const);

export interface EodhdFinanceOptions {
  apiKey: string;
  fetchLike?: FetchLike;
  timeoutMs?: number;
  now?: () => Date;
}

export function createEodhdFinanceConnector(options: EodhdFinanceOptions): FinancePort {
  if (!options.apiKey?.trim()) throw new Error('EODHD connector requires apiKey.');
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = options.now ?? (() => new Date());

  return {
    async getQuote(input: QuoteInput, ctx: ConnectorRunContext = {}): Promise<ResearchResult<Quote>> {
      const retrievedAt = now().toISOString();
      const mapped = mapInstrument(input.instrumentId);
      if (!mapped.parsed || !mapped.providerSymbol) return quoteFailure(PROVIDER, input.instrumentId, retrievedAt, mapped.code!, mapped.message!);
      try {
        const result = await request(`real-time/${encodeURIComponent(mapped.providerSymbol)}`, {}, ctx, options, timeoutMs);
        if (!result.ok) return quoteFailure(PROVIDER, input.instrumentId, retrievedAt, result.code, result.message);
        const row = result.payload as Record<string, unknown>;
        const price = finite(row.close);
        if (price === undefined || price <= 0) return quoteFailure(PROVIDER, input.instrumentId, retrievedAt, 'PARTIAL_DATA', `EODHD returned no usable quote for ${mapped.providerSymbol}.`);
        const timestamp = isoEpochSeconds(row.timestamp) ?? retrievedAt;
        const quote: Quote = {
          instrument: instrumentRef(mapped.parsed, PROVIDER, mapped.providerSymbol),
          price,
          ...(finite(row.change) !== undefined ? { change: finite(row.change)! } : {}),
          ...(finite(row.change_p) !== undefined ? { changePct: finite(row.change_p)! } : {}),
          ...(finite(row.volume) !== undefined ? { volume: finite(row.volume)! } : {}),
          currency: mapped.parsed.currency,
          timestamp,
          ...(finite(row.open) !== undefined ? { dayOpen: finite(row.open)! } : {}),
          ...(finite(row.high) !== undefined ? { dayHigh: finite(row.high)! } : {}),
          ...(finite(row.low) !== undefined ? { dayLow: finite(row.low)! } : {}),
          ...(finite(row.previousClose) !== undefined ? { previousClose: finite(row.previousClose)! } : {}),
        };
        return success(quote, mapped.providerSymbol, 'quote', timestamp, retrievedAt);
      } catch (error) {
        return quoteFailure(PROVIDER, input.instrumentId, retrievedAt, 'SOURCE_UNAVAILABLE', `EODHD quote failed: ${messageOf(error)}`);
      }
    },

    async getHistory(input: HistoryInput, ctx: ConnectorRunContext = {}): Promise<ResearchResult<PriceBar[]>> {
      const retrievedAt = now().toISOString();
      const mapped = mapInstrument(input.instrumentId);
      if (!mapped.parsed || !mapped.providerSymbol) return historyFailure(PROVIDER, retrievedAt, mapped.code!, mapped.message!);
      if (input.interval && input.interval !== '1d') return historyFailure(PROVIDER, retrievedAt, 'PARTIAL_DATA', 'EODHD fallback currently supports daily bars only.');
      try {
        const result = await request(`eod/${encodeURIComponent(mapped.providerSymbol)}`, {
          from: input.from,
          to: input.to,
          period: 'd',
        }, ctx, options, timeoutMs);
        if (!result.ok) return historyFailure(PROVIDER, retrievedAt, result.code, result.message);
        const rows = Array.isArray(result.payload) ? result.payload : [];
        const bars = rows.flatMap((value): PriceBar[] => {
          if (!value || typeof value !== 'object') return [];
          const row = value as Record<string, unknown>;
          const timestamp = stringValue(row.date);
          const open = finite(row.open);
          const high = finite(row.high);
          const low = finite(row.low);
          const close = finite(row.close);
          if (!timestamp || open === undefined || high === undefined || low === undefined || close === undefined) return [];
          return [{
            timestamp,
            open,
            high,
            low,
            close,
            ...(finite(row.adjusted_close) !== undefined ? { adjustedClose: finite(row.adjusted_close)! } : {}),
            ...(finite(row.volume) !== undefined ? { volume: finite(row.volume)! } : {}),
          }];
        }).sort((a, b) => a.timestamp.localeCompare(b.timestamp));
        if (bars.length === 0) return historyFailure(PROVIDER, retrievedAt, 'PARTIAL_DATA', `EODHD returned no history for ${mapped.providerSymbol}.`);
        return success(bars, mapped.providerSymbol, 'history', bars.at(-1)!.timestamp, retrievedAt);
      } catch (error) {
        return historyFailure(PROVIDER, retrievedAt, 'SOURCE_UNAVAILABLE', `EODHD history failed: ${messageOf(error)}`);
      }
    },

    async getProfile(input: ProfileInput, ctx: ConnectorRunContext = {}): Promise<ResearchResult<CompanyProfile>> {
      const retrievedAt = now().toISOString();
      const mapped = mapInstrument(input.instrumentId);
      if (!mapped.parsed || !mapped.providerSymbol) return profileFailure(PROVIDER, input.instrumentId, retrievedAt, mapped.code!, mapped.message!);
      try {
        const result = await request(`fundamentals/${encodeURIComponent(mapped.providerSymbol)}`, { filter: 'General' }, ctx, options, timeoutMs);
        if (!result.ok) return profileFailure(PROVIDER, input.instrumentId, retrievedAt, result.code, result.message);
        const row = result.payload && typeof result.payload === 'object' ? result.payload as Record<string, unknown> : {};
        const description = stringValue(row.Description);
        const sector = stringValue(row.Sector) ?? stringValue(row.GicSector);
        const industry = stringValue(row.Industry) ?? stringValue(row.GicIndustry);
        const website = stringValue(row.WebURL);
        const employees = nonNegativeInteger(row.FullTimeEmployees);
        if (!description && !sector && !industry && !website && employees === undefined) {
          return profileFailure(PROVIDER, input.instrumentId, retrievedAt, 'PARTIAL_DATA', `EODHD returned no usable profile for ${mapped.providerSymbol}.`);
        }
        const profile: CompanyProfile = {
          instrument: instrumentRef(mapped.parsed, PROVIDER, mapped.providerSymbol, stringValue(row.Exchange)),
          ...(description ? { description } : {}),
          ...(sector ? { sector } : {}),
          ...(industry ? { industry } : {}),
          ...(website ? { website } : {}),
          ...(employees !== undefined ? { employees } : {}),
        };
        return success(profile, mapped.providerSymbol, 'profile', isoDate(row.UpdatedAt) ?? retrievedAt, retrievedAt);
      } catch (error) {
        return profileFailure(PROVIDER, input.instrumentId, retrievedAt, 'SOURCE_UNAVAILABLE', `EODHD profile failed: ${messageOf(error)}`);
      }
    },
  };
}

type RequestResult =
  | { ok: true; payload: unknown }
  | { ok: false; code: ResearchWarning['code']; message: string };

async function request(
  path: string,
  params: Record<string, string>,
  ctx: ConnectorRunContext,
  options: EodhdFinanceOptions,
  timeoutMs: number,
): Promise<RequestResult> {
  const query = new URLSearchParams({ ...params, api_token: options.apiKey.trim(), fmt: 'json' });
  const fetchLike = resolveFetch(ctx, options);
  return withTimeout(ctx, ctx.timeoutMs ?? timeoutMs, async (signal) => {
    const response = await fetchLike(`${BASE_URL}/${path}?${query.toString()}`, { headers: { Accept: 'application/json' }, signal });
    if (!response.ok) {
      const message = response.text ? await response.text() : `HTTP ${response.status}`;
      return { ok: false, code: warningCode(response.status, message), message: `EODHD HTTP ${response.status}: ${message.slice(0, 160)}` };
    }
    return { ok: true, payload: await response.json() };
  });
}

function mapInstrument(instrumentId: string): {
  parsed?: ParsedFinanceInstrument;
  providerSymbol?: string;
  code?: 'INVALID_INSTRUMENT' | 'UNSUPPORTED_MARKET';
  message?: string;
} {
  const result = parseFinanceInstrument(instrumentId, SUPPORTED);
  if (!result.parsed) return { code: result.code as 'INVALID_INSTRUMENT' | 'UNSUPPORTED_MARKET', message: result.message };
  const parsed = result.parsed;
  if (parsed.market === 'US') return { parsed, providerSymbol: `${parsed.symbol.toUpperCase()}.US` };
  if (parsed.market === 'HK') {
    const digits = parsed.symbol.replace(/\.HK$/i, '');
    return { parsed, providerSymbol: `${/^\d+$/.test(digits) ? digits.padStart(4, '0').slice(-4) : digits}.HK` };
  }
  if (/^(5|6|9)/.test(parsed.symbol)) return { parsed, providerSymbol: `${parsed.symbol}.SHG` };
  if (/^(0|1|2|3)/.test(parsed.symbol)) return { parsed, providerSymbol: `${parsed.symbol}.SHE` };
  return { code: 'UNSUPPORTED_MARKET', message: `EODHD has no exchange mapping for ${instrumentId}.` };
}

function success<T>(data: T, symbol: string, kind: 'quote' | 'history' | 'profile', asOf: string, retrievedAt: string): ResearchResult<T> {
  return {
    schemaVersion: RESEARCH_SCHEMA_VERSION,
    data,
    citations: [{
      title: `EODHD ${kind}: ${symbol}`,
      url: `https://eodhd.com/financial-summary/${encodeURIComponent(symbol)}`,
      sourceType: kind === 'profile' ? 'OTHER' : 'PRICE',
      provider: PROVIDER,
      retrievedAt,
      qualityTier: 'B',
    }],
    freshness: [{ provider: PROVIDER, asOf, retrievedAt, stale: false }],
    warnings: [],
  };
}
