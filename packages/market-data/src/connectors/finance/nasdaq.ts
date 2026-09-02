/**
 * Key-free Nasdaq public market-data connector for US equities.
 *
 * It is intentionally a narrow complement to Yahoo: the public Nasdaq API
 * exposes delayed quote and daily historical bars, but not the richer
 * profile / valuation fields supplied by Yahoo. SnapshotV2 uses it only when
 * Yahoo returns unusable US quote or history data.
 */
import type { InstrumentRef } from '../../contracts/instrument';
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
import { failure as httpFailure, resolveFetch, withTimeout } from '../http';
import type { ConnectorRunContext, FetchLike } from '../types';

const PROVIDER = 'nasdaq';
const API_BASE = 'https://api.nasdaq.com/api/quote';
const SITE_BASE = 'https://www.nasdaq.com/market-activity/stocks';
const DEFAULT_TIMEOUT_MS = 7_000;
const REQUEST_HEADERS = {
  Accept: 'application/json, text/plain, */*',
  'User-Agent': 'Mozilla/5.0',
};

interface NasdaqPrimaryData {
  lastSalePrice?: string;
  netChange?: string;
  percentageChange?: string;
  volume?: string;
  currency?: string | null;
  lastTradeTimestamp?: string;
}

interface NasdaqInfoResponse {
  data?: {
    symbol?: string;
    exchange?: string;
    marketStatus?: string;
    primaryData?: NasdaqPrimaryData;
  } | null;
}

interface NasdaqHistoricalRow {
  date?: string;
  close?: string;
  volume?: string;
  open?: string;
  high?: string;
  low?: string;
}

interface NasdaqHistoricalResponse {
  data?: {
    tradesTable?: { rows?: NasdaqHistoricalRow[] } | null;
  } | null;
}

export interface NasdaqFinanceOptions {
  fetchLike?: FetchLike;
  timeoutMs?: number;
}

/**
 * Nasdaq is an exchange-owned source, but its public website API is delayed
 * and its availability is not contractual. Citations remain tier A by source
 * provenance; freshness records the latest published trading date.
 */
export function createNasdaqFinanceConnector(
  options: NasdaqFinanceOptions = {},
): FinancePort {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

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

      const fetchLike = resolveFetch(ctx, options);
      try {
        return await withTimeout(ctx, ctx.timeoutMs ?? timeoutMs, async (signal) => {
          const res = await fetchLike(
            `${API_BASE}/${encodeURIComponent(providerSymbol)}/info?assetclass=stocks`,
            { headers: REQUEST_HEADERS, signal },
          );
          if (!res.ok) {
            return quoteFailure(
              retrievedAt,
              res.status === 429 ? 'RATE_LIMITED' : 'SOURCE_UNAVAILABLE',
              `Nasdaq HTTP ${res.status} for ${parsed.symbol}`,
              `HTTP ${res.status}`,
            );
          }

          const payload = (await res.json()) as NasdaqInfoResponse;
          const data = payload.data;
          const primary = data?.primaryData;
          const price = parseDisplayedNumber(primary?.lastSalePrice);
          if (!data || price === null || price <= 0) {
            return quoteFailure(
              retrievedAt,
              'PARTIAL_DATA',
              `Nasdaq returned no usable quote for ${parsed.symbol}.`,
            );
          }

          const asOf = parseNasdaqDate(primary?.lastTradeTimestamp) ?? retrievedAt;
          const stale = isOlderThan(asOf, retrievedAt, 4);
          const warnings: ResearchWarning[] = [];
          if (stale) {
            warnings.push({
              code: 'STALE_DATA',
              message: `Nasdaq latest trade date ${primary?.lastTradeTimestamp ?? 'unknown'} is stale.`,
              provider: PROVIDER,
              sourceType: 'PRICE',
            });
          }

          const instrument: InstrumentRef = {
            instrumentId: parsed.instrumentId,
            market: 'US',
            symbol: parsed.symbol,
            ...(data.exchange ? { exchange: data.exchange } : {}),
            currency: primary?.currency ?? 'USD',
            providerSymbols: { nasdaq: providerSymbol },
          };
          const quote: Quote = {
            instrument,
            price,
            ...(numberField(primary?.netChange) !== null
              ? { change: numberField(primary?.netChange)! }
              : {}),
            ...(numberField(primary?.percentageChange) !== null
              ? { changePct: numberField(primary?.percentageChange)! }
              : {}),
            ...(numberField(primary?.volume) !== null
              ? { volume: numberField(primary?.volume)! }
              : {}),
            currency: primary?.currency ?? 'USD',
            marketStatus: mapMarketStatus(data.marketStatus),
            timestamp: asOf,
          };

          return {
            schemaVersion: RESEARCH_SCHEMA_VERSION,
            data: quote,
            citations: [quoteCitation(providerSymbol, retrievedAt)],
            freshness: [{ provider: PROVIDER, asOf, retrievedAt, stale }],
            warnings,
          };
        });
      } catch (error) {
        return quoteFailure(
          retrievedAt,
          'SOURCE_UNAVAILABLE',
          `Nasdaq quote request failed: ${messageOf(error)}`,
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
          'Nasdaq fallback supports daily bars only.',
        );
      }

      const from = normalizeRequestDate(input.from);
      const to = normalizeRequestDate(input.to);
      if (!from || !to || from > to) {
        return historyFailure(
          retrievedAt,
          'INVALID_INSTRUMENT',
          'Nasdaq history requires ISO from/to dates in ascending order.',
        );
      }

      const fetchLike = resolveFetch(ctx, options);
      try {
        return await withTimeout(ctx, ctx.timeoutMs ?? timeoutMs, async (signal) => {
          const url =
            `${API_BASE}/${encodeURIComponent(providerSymbol)}/historical` +
            `?assetclass=stocks&fromdate=${encodeURIComponent(from)}` +
            `&todate=${encodeURIComponent(to)}&limit=5000`;
          const res = await fetchLike(url, { headers: REQUEST_HEADERS, signal });
          if (!res.ok) {
            return historyFailure(
              retrievedAt,
              res.status === 429 ? 'RATE_LIMITED' : 'SOURCE_UNAVAILABLE',
              `Nasdaq HTTP ${res.status} for ${parsed.symbol} history`,
              `HTTP ${res.status}`,
            );
          }

          const payload = (await res.json()) as NasdaqHistoricalResponse;
          const bars = (payload.data?.tradesTable?.rows ?? [])
            .flatMap((row): PriceBar[] => {
              const timestamp = parseNasdaqDate(row.date);
              const close = parseDisplayedNumber(row.close);
              const open = parseDisplayedNumber(row.open);
              const high = parseDisplayedNumber(row.high);
              const low = parseDisplayedNumber(row.low);
              if (!timestamp || close === null || open === null || high === null || low === null) {
                return [];
              }
              return [{
                timestamp,
                open,
                high,
                low,
                close,
                ...(numberField(row.volume) !== null ? { volume: numberField(row.volume)! } : {}),
              }];
            })
            .sort((a, b) => a.timestamp.localeCompare(b.timestamp));

          if (bars.length === 0) {
            return historyFailure(
              retrievedAt,
              'PARTIAL_DATA',
              `Nasdaq returned no usable daily bars for ${parsed.symbol}.`,
            );
          }

          const asOf = bars[bars.length - 1]!.timestamp;
          const stale = isOlderThan(asOf, retrievedAt, 4);
          const warnings: ResearchWarning[] = stale
            ? [{
                code: 'STALE_DATA',
                message: `Nasdaq latest daily bar ${asOf.slice(0, 10)} is stale.`,
                provider: PROVIDER,
                sourceType: 'PRICE',
              }]
            : [];
          return {
            schemaVersion: RESEARCH_SCHEMA_VERSION,
            data: bars,
            citations: [{
              title: `Nasdaq historical prices: ${providerSymbol}`,
              url: `${SITE_BASE}/${encodeURIComponent(providerSymbol)}/historical`,
              sourceType: 'PRICE',
              provider: PROVIDER,
              retrievedAt,
              qualityTier: 'A',
            }],
            freshness: [{ provider: PROVIDER, asOf, retrievedAt, stale }],
            warnings,
          };
        });
      } catch (error) {
        return historyFailure(
          retrievedAt,
          'SOURCE_UNAVAILABLE',
          `Nasdaq history request failed: ${messageOf(error)}`,
        );
      }
    },
  };
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
      message: `Nasdaq fallback supports US instruments only, received ${parsed.market}.`,
    };
  }
  return { ok: true, instrumentId: parsed.raw, symbol: parsed.symbol };
}

function quoteCitation(symbol: string, retrievedAt: string) {
  return {
    title: `Nasdaq quote: ${symbol}`,
    url: `${SITE_BASE}/${encodeURIComponent(symbol)}`,
    sourceType: 'PRICE' as const,
    provider: PROVIDER,
    retrievedAt,
    qualityTier: 'A' as const,
  };
}

function quoteFailure(
  retrievedAt: string,
  code: ResearchWarning['code'],
  message: string,
  cause?: string,
): ResearchResult<Quote> {
  return httpFailure(PROVIDER, emptyQuote(), { retrievedAt, code, message, ...(cause ? { cause } : {}) });
}

function historyFailure(
  retrievedAt: string,
  code: ResearchWarning['code'],
  message: string,
  cause?: string,
): ResearchResult<PriceBar[]> {
  return httpFailure(PROVIDER, [], { retrievedAt, code, message, ...(cause ? { cause } : {}) });
}

function emptyQuote(): Quote {
  return {
    instrument: { instrumentId: '', market: 'US', symbol: '' },
    price: Number.NaN,
    currency: 'USD',
    timestamp: new Date(0).toISOString(),
  };
}

function parseDisplayedNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/[$,%\s,]/g, '').trim();
  if (!normalized || normalized === 'N/A' || normalized === '--') return null;
  const number = Number(normalized);
  return Number.isFinite(number) ? number : null;
}

function numberField(value: unknown): number | null {
  return parseDisplayedNumber(value);
}

function parseNasdaqDate(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const mmddyyyy = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value.trim());
  if (mmddyyyy) {
    const [, month, day, year] = mmddyyyy;
    return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day))).toISOString();
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

function normalizeRequestDate(value: string): string | null {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value))
    ? value
    : null;
}

function mapMarketStatus(value: string | undefined): Quote['marketStatus'] {
  switch (value?.trim().toLowerCase()) {
    case 'open':
    case 'market open':
      return 'OPEN';
    case 'closed':
    case 'market closed':
      return 'CLOSED';
    case 'pre-market':
    case 'pre market':
      return 'PRE_MARKET';
    case 'after hours':
    case 'after-hours':
      return 'AFTER_HOURS';
    default:
      return value ? 'UNKNOWN' : undefined;
  }
}

function isOlderThan(asOf: string, retrievedAt: string, days: number): boolean {
  return Date.parse(retrievedAt) - Date.parse(asOf) > days * 24 * 60 * 60_000;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message || error.name : String(error);
}
