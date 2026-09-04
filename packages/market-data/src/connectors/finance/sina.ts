/**
 * Key-free Sina Finance fallback for US end-of-day prices.
 *
 * Sina's public daily-K endpoint returns the complete series as JSONP. This
 * connector is deliberately last in the US source chain: it is useful when
 * Yahoo and Nasdaq are blocked, but it does not provide an exchange-live quote.
 */
import { RESEARCH_SCHEMA_VERSION, type ResearchResult } from '../../contracts/result';
import type { ResearchWarning } from '../../contracts/warning';
import type {
  ProviderFinancePort as FinancePort,
  HistoryInput,
  PriceBar,
  Quote,
  QuoteInput,
} from '../../ports/finance';
import { parseInstrumentId } from '../../util/instrument-id';
import { failure as httpFailure, resolveFetch, withTimeout, HttpError, failureCodeFor } from '../http';
import type { ConnectorRunContext, FetchLike } from '../types';

const PROVIDER = 'sina-finance';
const API_URL = 'https://stock.finance.sina.com.cn/usstock/api/jsonp.php/var%20data=/US_MinKService.getDailyK';
const QUOTE_PAGE = 'https://stock.finance.sina.com.cn/usstock/quotes';
const DEFAULT_TIMEOUT_MS = 3_000;
const CACHE_TTL_MS = 5 * 60_000;
const MAX_CACHE_ENTRIES = 8;

interface SinaDailyRow {
  d?: string;
  o?: string;
  h?: string;
  l?: string;
  c?: string;
  v?: string;
}

interface CachedSeries {
  expiresAt: number;
  promise: Promise<PriceBar[]>;
}

export interface SinaUsFinanceOptions {
  fetchLike?: FetchLike;
  timeoutMs?: number;
}

export function createSinaUsFinanceConnector(
  options: SinaUsFinanceOptions = {},
): FinancePort {
  const cache = new Map<string, CachedSeries>();

  const load = async (
    symbol: string,
    ctx: ConnectorRunContext,
  ): Promise<PriceBar[]> => {
    const cached = cache.get(symbol);
    if (cached && cached.expiresAt > Date.now()) return cached.promise;
    if (cached) cache.delete(symbol);

    const promise = fetchSeries(symbol, ctx, options).catch((error) => {
      cache.delete(symbol);
      throw error;
    });
    cache.set(symbol, { expiresAt: Date.now() + CACHE_TTL_MS, promise });
    while (cache.size > MAX_CACHE_ENTRIES) {
      const oldest = cache.keys().next().value as string | undefined;
      if (!oldest) break;
      cache.delete(oldest);
    }
    return promise;
  };

  return {
    async getQuote(
      input: QuoteInput,
      ctx: ConnectorRunContext = {},
    ): Promise<ResearchResult<Quote>> {
      const retrievedAt = new Date().toISOString();
      const parsed = parseUsInstrument(input.instrumentId);
      if (!parsed.ok) return quoteFailure(retrievedAt, parsed.code, parsed.message);
      const providerSymbol = ctx.resolvedInstrument?.instrumentId === parsed.instrumentId
        ? ctx.resolvedInstrument.providerSymbol
        : parsed.symbol;

      try {
        const bars = await load(providerSymbol, ctx);
        const latest = bars.at(-1);
        if (!latest) {
          return quoteFailure(
            retrievedAt,
            'PARTIAL_DATA',
            `Sina Finance returned no usable quote for ${parsed.symbol}.`,
          );
        }
        const previous = bars.at(-2);
        const change = previous ? latest.close - previous.close : undefined;
        const changePct = previous && previous.close > 0
          ? (change! / previous.close) * 100
          : undefined;
        const asOf = toIsoDate(latest.timestamp);
        const stale = isOlderThan(asOf, retrievedAt, 4);
        return {
          schemaVersion: RESEARCH_SCHEMA_VERSION,
          data: {
            instrument: {
              instrumentId: parsed.instrumentId,
              market: 'US',
              symbol: parsed.symbol,
              currency: 'USD',
              providerSymbols: { sina: providerSymbol },
            },
            price: latest.close,
            ...(change !== undefined ? { change } : {}),
            ...(changePct !== undefined ? { changePct } : {}),
            ...(latest.volume !== undefined ? { volume: latest.volume } : {}),
            dayOpen: latest.open,
            dayHigh: latest.high,
            dayLow: latest.low,
            ...(previous ? { previousClose: previous.close } : {}),
            currency: 'USD',
            marketStatus: 'UNKNOWN',
            timestamp: asOf,
          },
          citations: [citation(providerSymbol, retrievedAt, 'quote')],
          freshness: [{ provider: PROVIDER, asOf, retrievedAt, stale }],
          warnings: [
            {
              code: 'PARTIAL_DATA',
              message: 'Sina Finance fallback provides end-of-day, not exchange-live, US prices.',
              provider: PROVIDER,
              sourceType: 'PRICE',
            },
            ...(stale
              ? [{
                  code: 'STALE_DATA' as const,
                  message: `Sina Finance latest daily bar ${latest.timestamp} is stale.`,
                  provider: PROVIDER,
                  sourceType: 'PRICE' as const,
                }]
              : []),
          ],
        };
      } catch (error) {
        return quoteFailure(
          retrievedAt,
          failureCodeFor(error),
          `Sina Finance quote request failed: ${messageOf(error)}`,
        );
      }
    },

    async getHistory(
      input: HistoryInput,
      ctx: ConnectorRunContext = {},
    ): Promise<ResearchResult<PriceBar[]>> {
      const retrievedAt = new Date().toISOString();
      const parsed = parseUsInstrument(input.instrumentId);
      if (!parsed.ok) return historyFailure(retrievedAt, parsed.code, parsed.message);
      const providerSymbol = ctx.resolvedInstrument?.instrumentId === parsed.instrumentId
        ? ctx.resolvedInstrument.providerSymbol
        : parsed.symbol;
      if (input.interval && input.interval !== '1d') {
        return historyFailure(
          retrievedAt,
          'PARTIAL_DATA',
          'Sina Finance fallback supports daily bars only.',
        );
      }
      if (!isIsoDay(input.from) || !isIsoDay(input.to) || input.from > input.to) {
        return historyFailure(
          retrievedAt,
          'INVALID_INSTRUMENT',
          'Sina Finance history requires ISO from/to dates in ascending order.',
        );
      }

      try {
        const allBars = await load(providerSymbol, ctx);
        const bars = allBars.filter(
          (bar) => bar.timestamp >= input.from && bar.timestamp <= input.to,
        );
        if (bars.length === 0) {
          return historyFailure(
            retrievedAt,
            'PARTIAL_DATA',
            `Sina Finance returned no daily bars for ${parsed.symbol} in the requested range.`,
          );
        }
        const asOf = toIsoDate(bars.at(-1)!.timestamp);
        const stale = isOlderThan(asOf, retrievedAt, 4);
        return {
          schemaVersion: RESEARCH_SCHEMA_VERSION,
          data: bars,
          citations: [citation(providerSymbol, retrievedAt, 'historical prices')],
          freshness: [{ provider: PROVIDER, asOf, retrievedAt, stale }],
          warnings: stale
            ? [{
                code: 'STALE_DATA',
                message: `Sina Finance latest daily bar ${bars.at(-1)!.timestamp} is stale.`,
                provider: PROVIDER,
                sourceType: 'PRICE',
              }]
            : [],
        };
      } catch (error) {
        return historyFailure(
          retrievedAt,
          failureCodeFor(error),
          `Sina Finance history request failed: ${messageOf(error)}`,
        );
      }
    },
  };
}

async function fetchSeries(
  symbol: string,
  ctx: ConnectorRunContext,
  options: SinaUsFinanceOptions,
): Promise<PriceBar[]> {
  const fetchLike = resolveFetch(ctx, options);
  return withTimeout(ctx, ctx.timeoutMs ?? options.timeoutMs ?? DEFAULT_TIMEOUT_MS, async (signal) => {
    const url = `${API_URL}?symbol=${encodeURIComponent(symbol)}`;
    const response = await fetchLike(url, {
      headers: { Accept: 'application/javascript, text/plain, */*', 'User-Agent': 'Mozilla/5.0' },
      signal,
    });
    if (!response.ok) throw new HttpError(`HTTP ${response.status}`, response.status);
    if (!response.text) throw new Error('upstream response does not expose a text body');
    const body = await response.text();
    const rows = parseJsonp(body);
    const bars = rows.flatMap((row): PriceBar[] => {
      const open = finiteNumber(row.o);
      const high = finiteNumber(row.h);
      const low = finiteNumber(row.l);
      const close = finiteNumber(row.c);
      const volume = finiteNumber(row.v);
      if (!isIsoDay(row.d) || open === null || high === null || low === null || close === null) {
        return [];
      }
      if (open <= 0 || high <= 0 || low <= 0 || close <= 0) return [];
      return [{
        timestamp: row.d,
        open,
        high,
        low,
        close,
        ...(volume !== null && volume >= 0 ? { volume } : {}),
      }];
    });
    if (bars.length === 0) throw new Error(`no usable daily bars for ${symbol}`);
    return bars.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  });
}

function parseJsonp(body: string): SinaDailyRow[] {
  const start = body.indexOf('=(');
  const end = body.lastIndexOf(');');
  if (start < 0 || end <= start + 2) throw new Error('invalid JSONP payload');
  const payload = body.slice(start + 2, end).trim();
  if (payload === 'null') return [];
  const parsed = JSON.parse(payload) as unknown;
  if (!Array.isArray(parsed)) throw new Error('daily payload is not an array');
  return parsed as SinaDailyRow[];
}

function parseUsInstrument(instrumentId: string):
  | { ok: true; instrumentId: string; symbol: string }
  | { ok: false; code: ResearchWarning['code']; message: string } {
  const parsed = parseInstrumentId(instrumentId);
  if (!parsed) {
    return { ok: false, code: 'INVALID_INSTRUMENT', message: `Invalid instrumentId: ${instrumentId}` };
  }
  if (parsed.market !== 'US') {
    return {
      ok: false,
      code: 'UNSUPPORTED_MARKET',
      message: `Sina Finance fallback supports US instruments only, received ${parsed.market}.`,
    };
  }
  return { ok: true, instrumentId: parsed.raw, symbol: parsed.symbol.toUpperCase() };
}

function citation(symbol: string, retrievedAt: string, subject: string) {
  return {
    title: `Sina Finance ${subject}: ${symbol}`,
    url: `${QUOTE_PAGE}/${encodeURIComponent(symbol)}.html`,
    sourceType: 'PRICE' as const,
    provider: PROVIDER,
    retrievedAt,
    qualityTier: 'B' as const,
  };
}

function quoteFailure(
  retrievedAt: string,
  code: ResearchWarning['code'],
  message: string,
): ResearchResult<Quote> {
  return httpFailure(PROVIDER, emptyQuote(), { retrievedAt, code, message });
}

function historyFailure(
  retrievedAt: string,
  code: ResearchWarning['code'],
  message: string,
): ResearchResult<PriceBar[]> {
  return httpFailure(PROVIDER, [], { retrievedAt, code, message });
}

function emptyQuote(): Quote {
  return {
    instrument: { instrumentId: '', market: 'US', symbol: '' },
    price: Number.NaN,
    currency: 'USD',
    timestamp: new Date(0).toISOString(),
  };
}

function finiteNumber(value: unknown): number | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isIsoDay(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value));
}

function toIsoDate(day: string): string {
  return new Date(`${day}T00:00:00.000Z`).toISOString();
}

function isOlderThan(asOf: string, retrievedAt: string, days: number): boolean {
  return Date.parse(retrievedAt) - Date.parse(asOf) > days * 24 * 60 * 60_000;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message || error.name : String(error);
}
