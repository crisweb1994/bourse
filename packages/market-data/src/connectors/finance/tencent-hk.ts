/** Key-free Tencent Finance fallback for Hong Kong end-of-day prices. */
import { RESEARCH_SCHEMA_VERSION, type ResearchResult } from '../../contracts/result';
import type { ResearchWarning } from '../../contracts/warning';
import type { ProviderFinancePort as FinancePort, HistoryInput, PriceBar, Quote, QuoteInput } from '../../ports/finance';
import { parseInstrumentId } from '../../util/instrument-id';
import { failure as httpFailure, resolveFetch, withTimeout, HttpError, failureCodeFor } from '../http';
import type { ConnectorRunContext, FetchLike } from '../types';

const PROVIDER = 'tencent-finance';
const API_URL = 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get';
const QUOTE_PAGE = 'https://gu.qq.com/hk';
const DEFAULT_TIMEOUT_MS = 3_000;
const CACHE_TTL_MS = 60_000;

interface TencentKlineResponse {
  code?: number;
  data?: Record<string, { day?: unknown[] }>;
}

export interface TencentHkFinanceOptions {
  fetchLike?: FetchLike;
  timeoutMs?: number;
}

export function createTencentHkFinanceConnector(
  options: TencentHkFinanceOptions = {},
): FinancePort {
  const cache = new Map<string, { expiresAt: number; promise: Promise<PriceBar[]> }>();

  const load = (symbol: string, ctx: ConnectorRunContext): Promise<PriceBar[]> => {
    const cached = cache.get(symbol);
    if (cached && cached.expiresAt > Date.now()) return cached.promise;
    const promise = fetchSeries(symbol, ctx, options).catch((error) => {
      cache.delete(symbol);
      throw error;
    });
    cache.set(symbol, { expiresAt: Date.now() + CACHE_TTL_MS, promise });
    return promise;
  };

  return {
    async getQuote(input: QuoteInput, ctx: ConnectorRunContext = {}): Promise<ResearchResult<Quote>> {
      const retrievedAt = new Date().toISOString();
      const parsed = parseHkInstrument(input.instrumentId);
      if (!parsed.ok) return quoteFailure(retrievedAt, parsed.code, parsed.message);
      const providerSymbol = ctx.resolvedInstrument?.instrumentId === parsed.instrumentId
        ? ctx.resolvedInstrument.providerSymbol
        : `hk${parsed.symbol}`;
      try {
        const bars = await load(providerSymbol, ctx);
        const latest = bars.at(-1);
        if (!latest) return quoteFailure(retrievedAt, 'PARTIAL_DATA', 'Tencent returned no HK quote.');
        const previous = bars.at(-2);
        const change = previous ? latest.close - previous.close : undefined;
        const asOf = toIsoDate(latest.timestamp);
        const stale = isOlderThan(asOf, retrievedAt, 4);
        return {
          schemaVersion: RESEARCH_SCHEMA_VERSION,
          data: {
            instrument: {
              instrumentId: parsed.instrumentId,
              market: 'HK',
              symbol: parsed.symbol,
              currency: 'HKD',
              providerSymbols: { tencent: providerSymbol },
            },
            price: latest.close,
            ...(change !== undefined ? { change } : {}),
            ...(change !== undefined && previous!.close > 0
              ? { changePct: (change / previous!.close) * 100 }
              : {}),
            ...(latest.volume !== undefined ? { volume: latest.volume } : {}),
            dayOpen: latest.open,
            dayHigh: latest.high,
            dayLow: latest.low,
            ...(previous ? { previousClose: previous.close } : {}),
            currency: 'HKD',
            marketStatus: 'UNKNOWN',
            timestamp: asOf,
          },
          citations: [citation(parsed.symbol, retrievedAt, 'quote')],
          freshness: [{ provider: PROVIDER, asOf, retrievedAt, stale }],
          warnings: [{
            code: 'PARTIAL_DATA',
            message: 'Tencent Finance fallback provides end-of-day HK prices.',
            provider: PROVIDER,
            sourceType: 'PRICE',
          }],
        };
      } catch (error) {
        return quoteFailure(retrievedAt, failureCodeFor(error), `Tencent HK quote failed: ${messageOf(error)}`);
      }
    },

    async getHistory(input: HistoryInput, ctx: ConnectorRunContext = {}): Promise<ResearchResult<PriceBar[]>> {
      const retrievedAt = new Date().toISOString();
      const parsed = parseHkInstrument(input.instrumentId);
      if (!parsed.ok) return historyFailure(retrievedAt, parsed.code, parsed.message);
      const providerSymbol = ctx.resolvedInstrument?.instrumentId === parsed.instrumentId
        ? ctx.resolvedInstrument.providerSymbol
        : `hk${parsed.symbol}`;
      if (input.interval && input.interval !== '1d') {
        return historyFailure(retrievedAt, 'PARTIAL_DATA', 'Tencent HK fallback supports daily bars only.');
      }
      if (!isIsoDay(input.from) || !isIsoDay(input.to) || input.from > input.to) {
        return historyFailure(retrievedAt, 'INVALID_INSTRUMENT', 'Tencent HK history requires valid ISO dates.');
      }
      try {
        const bars = (await load(providerSymbol, ctx)).filter(
          (bar) => bar.timestamp >= input.from && bar.timestamp <= input.to,
        );
        if (bars.length === 0) {
          return historyFailure(retrievedAt, 'PARTIAL_DATA', `Tencent returned no HK history for ${parsed.symbol}.`);
        }
        const asOf = toIsoDate(bars.at(-1)!.timestamp);
        const stale = isOlderThan(asOf, retrievedAt, 4);
        return {
          schemaVersion: RESEARCH_SCHEMA_VERSION,
          data: bars,
          citations: [citation(parsed.symbol, retrievedAt, 'historical prices')],
          freshness: [{ provider: PROVIDER, asOf, retrievedAt, stale }],
          warnings: stale
            ? [{
                code: 'STALE_DATA',
                message: `Tencent latest HK daily bar ${bars.at(-1)!.timestamp} is stale.`,
                provider: PROVIDER,
                sourceType: 'PRICE',
              }]
            : [],
        };
      } catch (error) {
        return historyFailure(retrievedAt, failureCodeFor(error), `Tencent HK history failed: ${messageOf(error)}`);
      }
    },
  };
}

async function fetchSeries(
  symbol: string,
  ctx: ConnectorRunContext,
  options: TencentHkFinanceOptions,
): Promise<PriceBar[]> {
  const fetchLike = resolveFetch(ctx, options);
  return withTimeout(ctx, ctx.timeoutMs ?? options.timeoutMs ?? DEFAULT_TIMEOUT_MS, async (signal) => {
    const providerSymbol = symbol;
    const url = `${API_URL}?param=${providerSymbol},day,,,320,qfq`;
    const response = await fetchLike(url, {
      headers: { Accept: 'application/json, text/plain, */*', 'User-Agent': 'Mozilla/5.0' },
      signal,
    });
    if (!response.ok) throw new HttpError(`HTTP ${response.status}`, response.status);
    const payload = await response.json() as TencentKlineResponse;
    const rows = payload.data?.[providerSymbol]?.day;
    if (payload.code !== 0 || !Array.isArray(rows)) throw new Error('invalid or empty kline payload');
    const bars = rows.flatMap((raw): PriceBar[] => {
      if (!Array.isArray(raw)) return [];
      const [day, openRaw, closeRaw, highRaw, lowRaw, volumeRaw] = raw;
      const open = finiteNumber(openRaw);
      const close = finiteNumber(closeRaw);
      const high = finiteNumber(highRaw);
      const low = finiteNumber(lowRaw);
      const volume = finiteNumber(volumeRaw);
      if (!isIsoDay(day) || open === null || close === null || high === null || low === null) return [];
      if (open <= 0 || close <= 0 || high <= 0 || low <= 0) return [];
      return [{ timestamp: day, open, close, high, low, ...(volume !== null ? { volume } : {}) }];
    }).sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    if (bars.length === 0) throw new Error(`no usable daily bars for ${symbol}`);
    return bars;
  });
}

function parseHkInstrument(instrumentId: string):
  | { ok: true; instrumentId: string; symbol: string }
  | { ok: false; code: ResearchWarning['code']; message: string } {
  const parsed = parseInstrumentId(instrumentId);
  if (!parsed) return { ok: false, code: 'INVALID_INSTRUMENT', message: `Invalid instrumentId: ${instrumentId}` };
  if (parsed.market !== 'HK') {
    return { ok: false, code: 'UNSUPPORTED_MARKET', message: `Tencent HK fallback received ${parsed.market}.` };
  }
  return { ok: true, instrumentId: parsed.raw, symbol: parsed.symbol.padStart(5, '0') };
}

function citation(symbol: string, retrievedAt: string, subject: string) {
  return {
    title: `Tencent Finance ${subject}: ${symbol}`,
    url: `${QUOTE_PAGE}${encodeURIComponent(symbol)}`,
    sourceType: 'PRICE' as const,
    provider: PROVIDER,
    retrievedAt,
    qualityTier: 'B' as const,
  };
}

function quoteFailure(retrievedAt: string, code: ResearchWarning['code'], message: string): ResearchResult<Quote> {
  return httpFailure(PROVIDER, {
    instrument: { instrumentId: '', market: 'HK', symbol: '' },
    price: Number.NaN,
    currency: 'HKD',
    timestamp: new Date(0).toISOString(),
  }, { retrievedAt, code, message });
}

function historyFailure(retrievedAt: string, code: ResearchWarning['code'], message: string): ResearchResult<PriceBar[]> {
  return httpFailure(PROVIDER, [], { retrievedAt, code, message });
}

function finiteNumber(value: unknown): number | null {
  const parsed = typeof value === 'number' || typeof value === 'string' ? Number(value) : Number.NaN;
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
