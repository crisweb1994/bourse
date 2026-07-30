import { RESEARCH_SCHEMA_VERSION, type ResearchResult } from '../../contracts/result';
import type { ResearchWarning } from '../../contracts/warning';
import type {
  CompanyProfile,
  ProviderFinancePort as FinancePort,
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
  messageOf,
  parseFinanceInstrument,
  profileFailure,
  quoteFailure,
  stringValue,
  warningCode,
} from './commercial-common';

const PROVIDER = 'alpha-vantage';
const BASE_URL = 'https://www.alphavantage.co/query';
const DEFAULT_TIMEOUT_MS = 10_000;
const SUPPORTED = new Set(['US'] as const);

type AlphaPayload = Record<string, unknown> & {
  Note?: string;
  Information?: string;
  'Error Message'?: string;
};

export interface AlphaVantageFinanceOptions {
  apiKey: string;
  fetchLike?: FetchLike;
  timeoutMs?: number;
  now?: () => Date;
}

export function createAlphaVantageFinanceConnector(
  options: AlphaVantageFinanceOptions,
): FinancePort {
  if (!options.apiKey?.trim()) throw new Error('Alpha Vantage connector requires apiKey.');
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = options.now ?? (() => new Date());

  return {
    async getQuote(input: QuoteInput, ctx: ConnectorRunContext = {}): Promise<ResearchResult<Quote>> {
      const retrievedAt = now().toISOString();
      const parsedResult = parseFinanceInstrument(input.instrumentId, SUPPORTED);
      if (!parsedResult.parsed) return quoteFailure(PROVIDER, input.instrumentId, retrievedAt, parsedResult.code!, parsedResult.message!);
      const parsed = parsedResult.parsed;
      const providerSymbol = ctx.resolvedInstrument?.instrumentId === parsed.instrumentId ? ctx.resolvedInstrument.providerSymbol : parsed.symbol;
      try {
        const payload = await request({ function: 'GLOBAL_QUOTE', symbol: providerSymbol }, ctx, options, timeoutMs);
        const error = apiError(payload);
        if (error) return quoteFailure(PROVIDER, input.instrumentId, retrievedAt, error.code, error.message);
        const row = payload['Global Quote'];
        if (!row || typeof row !== 'object') return quoteFailure(PROVIDER, input.instrumentId, retrievedAt, 'PARTIAL_DATA', `Alpha Vantage returned no quote for ${parsed.symbol}.`);
        const quoteRow = row as Record<string, unknown>;
        const price = finite(quoteRow['05. price']);
        if (price === undefined || price <= 0) return quoteFailure(PROVIDER, input.instrumentId, retrievedAt, 'PARTIAL_DATA', `Alpha Vantage returned no usable price for ${parsed.symbol}.`);
        const timestamp = isoDate(quoteRow['07. latest trading day']) ?? retrievedAt;
        const quote: Quote = {
          instrument: instrumentRef(parsed, PROVIDER, providerSymbol),
          price,
          ...(finite(quoteRow['09. change']) !== undefined ? { change: finite(quoteRow['09. change'])! } : {}),
          ...(finite(quoteRow['10. change percent']) !== undefined ? { changePct: finite(quoteRow['10. change percent'])! } : {}),
          ...(finite(quoteRow['06. volume']) !== undefined ? { volume: finite(quoteRow['06. volume'])! } : {}),
          currency: 'USD',
          timestamp,
          ...(finite(quoteRow['02. open']) !== undefined ? { dayOpen: finite(quoteRow['02. open'])! } : {}),
          ...(finite(quoteRow['03. high']) !== undefined ? { dayHigh: finite(quoteRow['03. high'])! } : {}),
          ...(finite(quoteRow['04. low']) !== undefined ? { dayLow: finite(quoteRow['04. low'])! } : {}),
          ...(finite(quoteRow['08. previous close']) !== undefined ? { previousClose: finite(quoteRow['08. previous close'])! } : {}),
        };
        return success(quote, providerSymbol, 'quote', timestamp, retrievedAt);
      } catch (error) {
        return quoteFailure(PROVIDER, input.instrumentId, retrievedAt, 'SOURCE_UNAVAILABLE', `Alpha Vantage quote failed: ${messageOf(error)}`);
      }
    },

    async getHistory(input: HistoryInput, ctx: ConnectorRunContext = {}): Promise<ResearchResult<PriceBar[]>> {
      const retrievedAt = now().toISOString();
      const parsedResult = parseFinanceInstrument(input.instrumentId, SUPPORTED);
      if (!parsedResult.parsed) return historyFailure(PROVIDER, retrievedAt, parsedResult.code!, parsedResult.message!);
      if (input.interval && input.interval !== '1d') return historyFailure(PROVIDER, retrievedAt, 'PARTIAL_DATA', 'Alpha Vantage fallback currently supports daily bars only.');
      const parsed = parsedResult.parsed;
      const providerSymbol = ctx.resolvedInstrument?.instrumentId === parsed.instrumentId ? ctx.resolvedInstrument.providerSymbol : parsed.symbol;
      const days = Math.max(0, (Date.parse(input.to) - Date.parse(input.from)) / 86_400_000);
      try {
        const payload = await request({
          function: 'TIME_SERIES_DAILY',
          symbol: providerSymbol,
          outputsize: days > 100 ? 'full' : 'compact',
        }, ctx, options, timeoutMs);
        const error = apiError(payload);
        if (error) return historyFailure(PROVIDER, retrievedAt, error.code, error.message);
        const series = payload['Time Series (Daily)'];
        if (!series || typeof series !== 'object') return historyFailure(PROVIDER, retrievedAt, 'PARTIAL_DATA', `Alpha Vantage returned no daily series for ${parsed.symbol}.`);
        const bars = Object.entries(series as Record<string, unknown>).flatMap(([date, value]): PriceBar[] => {
          if (date < input.from || date > input.to || !value || typeof value !== 'object') return [];
          const row = value as Record<string, unknown>;
          const open = finite(row['1. open']);
          const high = finite(row['2. high']);
          const low = finite(row['3. low']);
          const close = finite(row['4. close']);
          if (open === undefined || high === undefined || low === undefined || close === undefined) return [];
          return [{ timestamp: date, open, high, low, close, ...(finite(row['5. volume']) !== undefined ? { volume: finite(row['5. volume'])! } : {}) }];
        }).sort((a, b) => a.timestamp.localeCompare(b.timestamp));
        if (bars.length === 0) return historyFailure(PROVIDER, retrievedAt, 'PARTIAL_DATA', `Alpha Vantage returned no history for ${parsed.symbol} in the requested range.`);
        return success(bars, providerSymbol, 'history', bars.at(-1)!.timestamp, retrievedAt);
      } catch (error) {
        return historyFailure(PROVIDER, retrievedAt, 'SOURCE_UNAVAILABLE', `Alpha Vantage history failed: ${messageOf(error)}`);
      }
    },

    async getProfile(input: ProfileInput, ctx: ConnectorRunContext = {}): Promise<ResearchResult<CompanyProfile>> {
      const retrievedAt = now().toISOString();
      const parsedResult = parseFinanceInstrument(input.instrumentId, SUPPORTED);
      if (!parsedResult.parsed) return profileFailure(PROVIDER, input.instrumentId, retrievedAt, parsedResult.code!, parsedResult.message!);
      const parsed = parsedResult.parsed;
      const providerSymbol = ctx.resolvedInstrument?.instrumentId === parsed.instrumentId ? ctx.resolvedInstrument.providerSymbol : parsed.symbol;
      try {
        const payload = await request({ function: 'OVERVIEW', symbol: providerSymbol }, ctx, options, timeoutMs);
        const error = apiError(payload);
        if (error) return profileFailure(PROVIDER, input.instrumentId, retrievedAt, error.code, error.message);
        const description = stringValue(payload.Description);
        const sector = stringValue(payload.Sector);
        const industry = stringValue(payload.Industry);
        const website = stringValue(payload.OfficialSite);
        const marketCap = finite(payload.MarketCapitalization);
        if (!description && !sector && !industry && !website && marketCap === undefined) {
          return profileFailure(PROVIDER, input.instrumentId, retrievedAt, 'PARTIAL_DATA', `Alpha Vantage returned no usable overview for ${parsed.symbol}.`);
        }
        const profile: CompanyProfile = {
          instrument: instrumentRef(parsed, PROVIDER, providerSymbol, stringValue(payload.Exchange)),
          ...(description ? { description } : {}),
          ...(sector ? { sector } : {}),
          ...(industry ? { industry } : {}),
          ...(website ? { website } : {}),
          ...(marketCap !== undefined ? { marketCap } : {}),
        };
        return success(profile, providerSymbol, 'profile', retrievedAt, retrievedAt);
      } catch (error) {
        return profileFailure(PROVIDER, input.instrumentId, retrievedAt, 'SOURCE_UNAVAILABLE', `Alpha Vantage profile failed: ${messageOf(error)}`);
      }
    },
  };
}

async function request(
  params: Record<string, string>,
  ctx: ConnectorRunContext,
  options: AlphaVantageFinanceOptions,
  timeoutMs: number,
): Promise<AlphaPayload> {
  const query = new URLSearchParams({ ...params, apikey: options.apiKey.trim() });
  const fetchLike = resolveFetch(ctx, options);
  return withTimeout(ctx, ctx.timeoutMs ?? timeoutMs, async (signal) => {
    const response = await fetchLike(`${BASE_URL}?${query.toString()}`, { headers: { Accept: 'application/json' }, signal });
    const payload = await response.json() as AlphaPayload;
    if (!response.ok) {
      const message = apiMessage(payload) ?? `HTTP ${response.status}`;
      return { 'Error Message': `${response.status}: ${message}` };
    }
    return payload;
  });
}

function apiMessage(payload: AlphaPayload): string | undefined {
  return stringValue(payload['Error Message']) ?? stringValue(payload.Note) ?? stringValue(payload.Information);
}

function apiError(payload: AlphaPayload): { code: ResearchWarning['code']; message: string } | null {
  const message = apiMessage(payload);
  if (!message) return null;
  return { code: warningCode(undefined, message), message };
}

function success<T>(data: T, symbol: string, kind: 'quote' | 'history' | 'profile', asOf: string, retrievedAt: string): ResearchResult<T> {
  return {
    schemaVersion: RESEARCH_SCHEMA_VERSION,
    data,
    citations: [{
      title: `Alpha Vantage ${kind}: ${symbol}`,
      url: `https://www.alphavantage.co/query?function=${kind === 'profile' ? 'OVERVIEW' : kind === 'history' ? 'TIME_SERIES_DAILY' : 'GLOBAL_QUOTE'}&symbol=${encodeURIComponent(symbol)}`,
      sourceType: kind === 'profile' ? 'OTHER' : 'PRICE',
      provider: PROVIDER,
      retrievedAt,
      qualityTier: 'B',
    }],
    freshness: [{ provider: PROVIDER, asOf, retrievedAt, stale: false }],
    warnings: [],
  };
}
