import type { InstrumentRef, MarketCode } from '../../contracts/instrument';
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
import { parseInstrumentId } from '../../util/instrument-id';
import type { ConnectorRunContext, FetchLike } from '../types';
import { failure as httpFailure, resolveFetch, withTimeout } from '../http';

const PROVIDER = 'yahoo';
const QUOTE_URL = 'https://query1.finance.yahoo.com/v8/finance/chart';
// refactor-v1 / RFC financials §3.9: chart endpoint 不带 marketCap/PE。
// 并行调 quoteSummary 拉 summaryDetail module 补这两个字段。
// Hotfix (2026-05-25): quoteSummary 端点现在强制 crumb 反爬 token，2024+ 改
// 制。原 fail-soft 静默吞 401 导致 marketCap/PE 永远 undefined。修：在
// connector 里维护 cookie + crumb 缓存（~30min TTL），auto-retry once on
// 401 to refresh the crumb.
const SUMMARY_URL = 'https://query2.finance.yahoo.com/v10/finance/quoteSummary';
const CRUMB_URL = 'https://query2.finance.yahoo.com/v1/test/getcrumb';
const COOKIE_URL = 'https://fc.yahoo.com';
const CRUMB_TTL_MS = 30 * 60_000; // 30 min — Yahoo rotates crumbs occasionally
// Yahoo's getcrumb / quoteSummary endpoints 429 the full Chrome UA string but
// serve a plain `Mozilla/5.0` (verified 2026-05-30) — the same UA the v8 chart
// request already uses successfully. Using the elaborate UA here silently
// broke the entire crumb path (marketCap / PE / marketState all dropped).
const YAHOO_UA = 'Mozilla/5.0';
const DEFAULT_TIMEOUT_MS = 5000;

/**
 * Module-scoped crumb/cookie cache. Yahoo's quoteSummary endpoint needs:
 *  1. A session cookie (A1, A3 from fc.yahoo.com)
 *  2. A crumb token tied to that cookie (from /v1/test/getcrumb)
 * The crumb is appended as `?crumb=...` on quoteSummary requests. Both
 * expire — we cache for 30min and refresh on 401.
 */
interface CrumbCache {
  cookie: string;
  crumb: string;
  expiresAt: number;
}
let CRUMB_CACHE: CrumbCache | null = null;

/** Test-only: clear the module crumb cache. */
export function __resetYahooCrumbCache(): void {
  CRUMB_CACHE = null;
}

/**
 * Test-only: seed the crumb cache so `fetchSummaryDetail` skips the live
 * cookie+crumb dance and goes straight to the (mocked) summaryDetail call.
 */
export function __seedYahooCrumbCacheForTest(crumb: string, cookie = 'A1=test'): void {
  CRUMB_CACHE = { cookie, crumb, expiresAt: Date.now() + CRUMB_TTL_MS };
}

async function getCrumb(force = false): Promise<CrumbCache | null> {
  if (!force && CRUMB_CACHE && CRUMB_CACHE.expiresAt > Date.now()) {
    return CRUMB_CACHE;
  }
  try {
    // Step 1: trigger Yahoo's anti-bot to set the A1 / A3 cookies. fc.yahoo.com
    // returns 404 but Set-Cookie headers still come through. We use the
    // native fetch (not FetchLike) so we can read Response.headers.
    const cookieRes = await fetch(COOKIE_URL, {
      headers: { 'User-Agent': YAHOO_UA },
    });
    const setCookieRaw =
      typeof cookieRes.headers.getSetCookie === 'function'
        ? cookieRes.headers.getSetCookie()
        : (cookieRes.headers.get('set-cookie') ?? '').split(/,(?=[^,]+=)/);
    const cookie = setCookieRaw
      .map((c) => c.split(';')[0]?.trim())
      .filter((s): s is string => Boolean(s))
      .join('; ');
    if (!cookie) return null;

    // Step 2: exchange cookie for a crumb.
    const crumbRes = await fetch(CRUMB_URL, {
      headers: { 'User-Agent': YAHOO_UA, Cookie: cookie },
    });
    if (!crumbRes.ok) return null;
    const crumb = (await crumbRes.text()).trim();
    if (!crumb) return null;

    CRUMB_CACHE = { cookie, crumb, expiresAt: Date.now() + CRUMB_TTL_MS };
    return CRUMB_CACHE;
  } catch {
    return null;
  }
}

const CURRENCY_BY_MARKET: Record<MarketCode, string> = {
  US: 'USD',
  HK: 'HKD',
  CN: 'CNY',
  JP: 'JPY',
  UK: 'GBP',
};

/** Yahoo handles US + HK natively. CN/JP/UK return UNSUPPORTED in this
 *  connector — CN flows through the agent CN connector (C8), JP/UK aren't
 *  supported in Phase 1–4 (PRD §8.1). */
const YAHOO_SUPPORTED: ReadonlySet<MarketCode> = new Set<MarketCode>(['US', 'HK']);

interface YahooChartMeta {
  currency?: string;
  symbol?: string;
  exchangeName?: string;
  regularMarketPrice?: number;
  previousClose?: number;
  chartPreviousClose?: number;
  regularMarketTime?: number;
  regularMarketDayHigh?: number;
  regularMarketDayLow?: number;
  regularMarketVolume?: number;
  regularMarketDayOpen?: number;
  marketState?: string;
}

interface YahooChartResponse {
  chart?: {
    result?: Array<{ meta?: YahooChartMeta }> | null;
    error?: { code?: string; description?: string } | null;
  };
}

interface YahooRawValue {
  raw?: number;
  fmt?: string;
}

interface YahooSummaryDetail {
  marketCap?: YahooRawValue;
  trailingPE?: YahooRawValue;
  // 其他字段（forwardPE / priceToBook / 等）暂不抽，需要时加
}

interface YahooPriceModule {
  // Authoritative live session state from the exchange feed
  // (REGULAR / PRE / POST / PREPRE / POSTPOST / CLOSED). The v8 chart `meta`
  // leaves marketState null, so we read it here.
  marketState?: string;
}

interface YahooSummaryResponse {
  quoteSummary?: {
    result?: Array<{
      summaryDetail?: YahooSummaryDetail;
      price?: YahooPriceModule;
    }> | null;
    error?: { code?: string; description?: string } | null;
  };
}

interface SummaryDetailResult {
  marketCap?: number;
  peRatio?: number;
  /** Raw Yahoo session state (REGULAR/PRE/POST/CLOSED) from the price module. */
  marketState?: string;
}

/**
 * quoteSummary `assetProfile` module. Field names verified live (2026-05-30,
 * AAPL): longBusinessSummary / sector / industry / fullTimeEmployees / website.
 */
interface YahooAssetProfile {
  longBusinessSummary?: string;
  sector?: string;
  industry?: string;
  fullTimeEmployees?: number;
  website?: string;
}

interface YahooAssetProfileResponse {
  quoteSummary?: {
    result?: Array<{ assetProfile?: YahooAssetProfile }> | null;
    error?: { code?: string; description?: string } | null;
  };
}

/** Parsed assetProfile fields (instrument-agnostic). */
type AssetProfileResult = Omit<CompanyProfile, 'instrument'>;

/**
 * 拉 v10 quoteSummary `assetProfile` module → company profile fields. Reuses
 * the same cookie+crumb machinery as `fetchSummaryDetail` (cached 30min,
 * lazy-refresh on 401/403). Returns `null` on any unrecoverable error so the
 * caller can surface a SOURCE_UNAVAILABLE envelope.
 */
async function fetchAssetProfile(
  fetchLike: FetchLike,
  yahooSymbol: string,
  signal: AbortSignal,
): Promise<AssetProfileResult | null> {
  const attempt = async (forceRefresh: boolean): Promise<AssetProfileResult | null | 'retry'> => {
    const auth = await getCrumb(forceRefresh);
    if (!auth) return null;
    try {
      const url = `${SUMMARY_URL}/${encodeURIComponent(yahooSymbol)}?modules=assetProfile&crumb=${encodeURIComponent(auth.crumb)}`;
      const res = await fetchLike(url, {
        headers: { 'User-Agent': YAHOO_UA, Cookie: auth.cookie },
        signal,
      });
      if (res.status === 401 || res.status === 403) {
        return forceRefresh ? null : 'retry';
      }
      if (!res.ok) return null;
      const data = (await res.json()) as YahooAssetProfileResponse;
      const ap = data.quoteSummary?.result?.[0]?.assetProfile;
      if (!ap) return null;
      return {
        ...(typeof ap.longBusinessSummary === 'string' && ap.longBusinessSummary.trim()
          ? { description: ap.longBusinessSummary.trim() }
          : {}),
        ...(typeof ap.sector === 'string' && ap.sector.trim() ? { sector: ap.sector.trim() } : {}),
        ...(typeof ap.industry === 'string' && ap.industry.trim() ? { industry: ap.industry.trim() } : {}),
        ...(typeof ap.fullTimeEmployees === 'number' && Number.isFinite(ap.fullTimeEmployees)
          ? { employees: ap.fullTimeEmployees }
          : {}),
        ...(typeof ap.website === 'string' && ap.website.trim() ? { website: ap.website.trim() } : {}),
      };
    } catch {
      return null;
    }
  };
  const first = await attempt(false);
  if (first !== 'retry') return first;
  const second = await attempt(true);
  return second === 'retry' ? null : second;
}

/**
 * 拉 v10 quoteSummary `summaryDetail` + `price` modules → 取 marketCap +
 * trailingPE + 权威 marketState。
 *
 * Flow (2024+ Yahoo anti-bot):
 *   1. Ensure we have a valid cookie + crumb pair (cached 30min, lazy-refresh).
 *   2. GET `${SUMMARY_URL}/${symbol}?modules=summaryDetail,price&crumb=${crumb}`
 *      with Cookie header. Returns 401 if crumb stale → retry once with a
 *      fresh crumb.
 *   3. Parse marketCap.raw + trailingPE.raw + price.marketState.
 *
 * Fail-soft: any unrecoverable error returns `{}` so the caller keeps the
 * quote without marketCap/PE/marketState (callers then derive state from the
 * exchange clock). Tests should mock `__resetYahooCrumbCache()` + a pre-seeded
 * crumb via the test fetchLike adapter, OR stub the global fetch for the
 * cookie/crumb steps.
 */
async function fetchSummaryDetail(
  fetchLike: FetchLike,
  yahooSymbol: string,
  signal: AbortSignal,
): Promise<SummaryDetailResult> {
  const attempt = async (forceRefresh: boolean): Promise<SummaryDetailResult | 'retry'> => {
    const auth = await getCrumb(forceRefresh);
    if (!auth) return {};
    try {
      const url = `${SUMMARY_URL}/${encodeURIComponent(yahooSymbol)}?modules=summaryDetail,price&crumb=${encodeURIComponent(auth.crumb)}`;
      const res = await fetchLike(url, {
        headers: { 'User-Agent': YAHOO_UA, Cookie: auth.cookie },
        signal,
      });
      if (res.status === 401 || res.status === 403) {
        return forceRefresh ? {} : 'retry';
      }
      if (!res.ok) return {};
      const data = (await res.json()) as YahooSummaryResponse;
      const result = data.quoteSummary?.result?.[0];
      const detail = result?.summaryDetail;
      const marketState = result?.price?.marketState;
      if (!detail && !marketState) return {};
      return {
        ...(detail?.marketCap?.raw != null ? { marketCap: detail.marketCap.raw } : {}),
        ...(detail?.trailingPE?.raw != null ? { peRatio: detail.trailingPE.raw } : {}),
        ...(marketState ? { marketState } : {}),
      };
    } catch {
      return {};
    }
  };
  const first = await attempt(false);
  if (first !== 'retry') return first;
  // 401/403 with cached crumb → refresh once and retry.
  const second = await attempt(true);
  return second === 'retry' ? {} : second;
}

export function createYahooFinanceConnector(): FinancePort {
  return {
    async getQuote(input: QuoteInput, ctx: ConnectorRunContext = {}): Promise<ResearchResult<Quote>> {
      const retrievedAt = new Date().toISOString();
      const parsed = parseInstrumentId(input.instrumentId);
      if (!parsed) {
        return failingEnvelope({
          retrievedAt,
          code: 'INVALID_INSTRUMENT',
          message: `Invalid instrumentId: ${input.instrumentId}`,
        });
      }
      if (!YAHOO_SUPPORTED.has(parsed.market)) {
        return failingEnvelope({
          retrievedAt,
          code: 'UNSUPPORTED_MARKET',
          message: `Yahoo finance connector does not support market ${parsed.market}.`,
        });
      }

      const yahooSymbol = toYahooSymbol(parsed.market, parsed.symbol);
      const fetchLike = resolveFetch(ctx);
      const timeoutMs = ctx.timeoutMs ?? DEFAULT_TIMEOUT_MS;

      try {
        return await withTimeout(ctx, timeoutMs, async (signal) => {
        // range=1d (not 5d): the v8 chart meta never returns `previousClose`,
        // so `change`/`changePct` fall back to `chartPreviousClose`, which is
        // the close immediately BEFORE the requested window. With range=5d
        // that was the 5-days-ago close → daily change was computed against the
        // wrong day (e.g. AAPL showed +2% vs a flat/down real day). range=1d
        // makes chartPreviousClose the actual prior trading day's close.
        const url = `${QUOTE_URL}/${encodeURIComponent(yahooSymbol)}?interval=1d&range=1d`;
        // RFC financials §3.9: 并行拉 summaryDetail 补 marketCap + trailingPE。
        //
        // plan-v2 Wave 1.8 — caller can opt out of summaryDetail entirely via
        // ctx.disableSummaryDetail. Per plan §5.3 #14 the long-term direction
        // is "all v8/chart"; summaryDetail stays as the default path until
        // marketCap can be sourced from financials.weightedAverageDilutedShares
        // × price. When disabled, marketCap + peRatio land as undefined.
        const summaryPromise = ctx.disableSummaryDetail
          ? Promise.resolve({} as SummaryDetailResult)
          : fetchSummaryDetail(fetchLike, yahooSymbol, signal);
        const [res, summaryDetail] = await Promise.all([
          fetchLike(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal }),
          summaryPromise,
        ]);

        if (!res.ok) {
          return failingEnvelope({
            retrievedAt,
            code: 'SOURCE_UNAVAILABLE',
            message: `Yahoo HTTP ${res.status} for ${yahooSymbol}`,
            cause: `HTTP ${res.status}`,
          });
        }

        const data = (await res.json()) as YahooChartResponse;

        if (data.chart?.error) {
          const e = data.chart.error;
          return failingEnvelope({
            retrievedAt,
            code: 'SOURCE_UNAVAILABLE',
            message: e.description ?? 'Yahoo chart error',
            cause: e.code ?? 'YAHOO_CHART_ERROR',
          });
        }

        const meta = data.chart?.result?.[0]?.meta;
        if (!meta || meta.regularMarketPrice == null) {
          return failingEnvelope({
            retrievedAt,
            code: 'PARTIAL_DATA',
            message: `Yahoo returned no quote for ${yahooSymbol}.`,
          });
        }

        const instrument: InstrumentRef = {
          instrumentId: parsed.raw,
          market: parsed.market,
          symbol: parsed.symbol,
          exchange: meta.exchangeName,
          currency: meta.currency ?? CURRENCY_BY_MARKET[parsed.market],
          providerSymbols: { yahoo: yahooSymbol },
        };

        const prev = meta.previousClose ?? meta.chartPreviousClose;
        const change = prev != null ? meta.regularMarketPrice - prev : undefined;
        const changePct = prev ? (change! / prev) * 100 : undefined;
        const asOf = meta.regularMarketTime
          ? new Date(meta.regularMarketTime * 1000).toISOString()
          : retrievedAt;

        const quote: Quote = {
          instrument,
          price: meta.regularMarketPrice,
          change,
          changePct,
          volume: meta.regularMarketVolume,
          currency: instrument.currency ?? CURRENCY_BY_MARKET[parsed.market],
          // Authoritative session state from the crumb'd price module (handles
          // holidays / half-days); the v8 chart meta.marketState is null, so it
          // only acts as a last-resort fallback.
          marketStatus: mapMarketState(summaryDetail.marketState ?? meta.marketState),
          timestamp: asOf,
          dayOpen: meta.regularMarketDayOpen,
          dayHigh: meta.regularMarketDayHigh,
          dayLow: meta.regularMarketDayLow,
          previousClose: prev,
          // RFC financials §3.9: marketCap + peRatio from summaryDetail.
          // summaryDetail fail-soft 时这两个字段保持 undefined（Quote.marketCap/peRatio
          // 都是 optional），EvidencePack facts.marketCap/pe 会落空 → dim 走 LLM 算。
          ...(summaryDetail.marketCap !== undefined ? { marketCap: summaryDetail.marketCap } : {}),
          ...(summaryDetail.peRatio !== undefined ? { peRatio: summaryDetail.peRatio } : {}),
        };

        return {
          schemaVersion: RESEARCH_SCHEMA_VERSION,
          data: quote,
          citations: [],
          freshness: [
            { provider: PROVIDER, asOf, retrievedAt, stale: false },
          ],
          warnings: [],
        };
        });
      } catch (err) {
        const message = (err as Error)?.message ?? String(err);
        return failingEnvelope({
          retrievedAt,
          code: 'SOURCE_UNAVAILABLE',
          message: `Yahoo finance error: ${message}`,
          cause: message,
        });
      }
    },

    async getHistory(input: HistoryInput, ctx: ConnectorRunContext = {}): Promise<ResearchResult<PriceBar[]>> {
      const retrievedAt = new Date().toISOString();
      const parsed = parseInstrumentId(input.instrumentId);
      if (!parsed) {
        return historyFailure({ retrievedAt, code: 'INVALID_INSTRUMENT', message: `Invalid instrumentId: ${input.instrumentId}` });
      }
      if (!YAHOO_SUPPORTED.has(parsed.market)) {
        return historyFailure({
          retrievedAt,
          code: 'UNSUPPORTED_MARKET',
          message: `Yahoo finance connector does not support market ${parsed.market}.`,
        });
      }
      // Phase 2 supports daily bars only; non-1d intervals silently fall back
      // with a warning rather than throwing.
      const warnings: ResearchWarning[] = [];
      const interval = input.interval ?? '1d';
      if (interval !== '1d') {
        warnings.push({
          code: 'PARTIAL_DATA',
          message: `interval=${interval} not supported in phase 2; returning 1d bars.`,
          provider: PROVIDER,
        });
      }
      const period1 = Math.floor(new Date(input.from).getTime() / 1000);
      const period2 = Math.floor(new Date(input.to).getTime() / 1000);
      if (!Number.isFinite(period1) || !Number.isFinite(period2) || period1 >= period2) {
        return historyFailure({
          retrievedAt,
          code: 'INVALID_INSTRUMENT', // closest typed code for malformed time range
          message: `Invalid history window: from=${input.from} to=${input.to}`,
        });
      }

      const yahooSymbol = toYahooSymbol(parsed.market, parsed.symbol);
      const fetchLike = resolveFetch(ctx);
      const timeoutMs = ctx.timeoutMs ?? DEFAULT_TIMEOUT_MS;

      try {
        return await withTimeout(ctx, timeoutMs, async (signal) => {
        const url =
          `${QUOTE_URL}/${encodeURIComponent(yahooSymbol)}` +
          `?period1=${period1}&period2=${period2}&interval=1d`;
        const res = await fetchLike(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal });
        if (!res.ok) {
          return historyFailure({
            retrievedAt,
            code: 'SOURCE_UNAVAILABLE',
            message: `Yahoo HTTP ${res.status} for ${yahooSymbol}`,
            cause: `HTTP ${res.status}`,
          });
        }
        const data = (await res.json()) as YahooChartResponse & {
          chart?: {
            result?: Array<{
              meta?: YahooChartMeta;
              timestamp?: number[];
              indicators?: {
                quote?: Array<{
                  open?: (number | null)[];
                  high?: (number | null)[];
                  low?: (number | null)[];
                  close?: (number | null)[];
                  volume?: (number | null)[];
                }>;
                adjclose?: Array<{ adjclose?: (number | null)[] }>;
              };
            }>;
          };
        };
        if (data.chart?.error) {
          const e = data.chart.error;
          return historyFailure({
            retrievedAt,
            code: 'SOURCE_UNAVAILABLE',
            message: e.description ?? 'Yahoo chart error',
            cause: e.code ?? 'YAHOO_CHART_ERROR',
          });
        }
        const result = data.chart?.result?.[0];
        const timestamps = result?.timestamp ?? [];
        const quote = result?.indicators?.quote?.[0];
        const adj = result?.indicators?.adjclose?.[0]?.adjclose;
        const bars: PriceBar[] = [];
        for (let i = 0; i < timestamps.length; i += 1) {
          const close = quote?.close?.[i];
          if (close == null) continue; // Yahoo emits null for non-trading days inside the range
          bars.push({
            timestamp: new Date(timestamps[i] * 1000).toISOString(),
            open: quote?.open?.[i] ?? close,
            high: quote?.high?.[i] ?? close,
            low: quote?.low?.[i] ?? close,
            close,
            adjustedClose: adj?.[i] ?? undefined,
            volume: quote?.volume?.[i] ?? undefined,
          });
        }
        return {
          schemaVersion: RESEARCH_SCHEMA_VERSION,
          data: bars,
          citations: [],
          freshness: [{ provider: PROVIDER, asOf: retrievedAt, retrievedAt, stale: false }],
          warnings,
        };
        });
      } catch (err) {
        const message = (err as Error)?.message ?? String(err);
        return historyFailure({
          retrievedAt,
          code: 'SOURCE_UNAVAILABLE',
          message: `Yahoo history error: ${message}`,
          cause: message,
        });
      }
    },

    async getProfile(
      input: ProfileInput,
      ctx: ConnectorRunContext = {},
    ): Promise<ResearchResult<CompanyProfile>> {
      const retrievedAt = new Date().toISOString();
      const parsed = parseInstrumentId(input.instrumentId);
      if (!parsed) {
        return profileFailure({
          retrievedAt,
          code: 'INVALID_INSTRUMENT',
          message: `Invalid instrumentId: ${input.instrumentId}`,
        });
      }
      if (!YAHOO_SUPPORTED.has(parsed.market)) {
        return profileFailure({
          retrievedAt,
          code: 'UNSUPPORTED_MARKET',
          message: `Yahoo finance connector does not support market ${parsed.market}.`,
        });
      }

      const yahooSymbol = toYahooSymbol(parsed.market, parsed.symbol);
      const fetchLike = resolveFetch(ctx);
      const timeoutMs = ctx.timeoutMs ?? DEFAULT_TIMEOUT_MS;

      try {
        return await withTimeout(ctx, timeoutMs, async (signal) => {
          const ap = await fetchAssetProfile(fetchLike, yahooSymbol, signal);
          if (!ap) {
            return profileFailure({
              retrievedAt,
              code: 'SOURCE_UNAVAILABLE',
              message: `Yahoo assetProfile unavailable for ${yahooSymbol}`,
            });
          }
          const instrument: InstrumentRef = {
            instrumentId: parsed.raw,
            market: parsed.market,
            symbol: parsed.symbol,
            currency: CURRENCY_BY_MARKET[parsed.market],
            providerSymbols: { yahoo: yahooSymbol },
          };
          const asOf = retrievedAt;
          return {
            schemaVersion: RESEARCH_SCHEMA_VERSION,
            data: { instrument, ...ap },
            citations: [],
            freshness: [{ provider: PROVIDER, asOf, retrievedAt, stale: false }],
            warnings: [],
          };
        });
      } catch (err) {
        const message = (err as Error)?.message ?? String(err);
        return profileFailure({
          retrievedAt,
          code: 'SOURCE_UNAVAILABLE',
          message: `Yahoo profile error: ${message}`,
          cause: message,
        });
      }
    },
  };
}

function toYahooSymbol(market: MarketCode, symbol: string): string {
  switch (market) {
    case 'US':
      return symbol;
    case 'HK': {
      // Canonical HK symbol is 5-digit (HK:00700); Yahoo wants
      // `0700.HK` — strip a single leading zero off a 5-digit code.
      const stripped = symbol.length === 5 && symbol.startsWith('0') ? symbol.slice(1) : symbol;
      return `${stripped}.HK`;
    }
    case 'JP':
      return `${symbol}.T`;
    case 'UK':
      return `${symbol}.L`;
    case 'CN':
      // Best-effort suffix; CN flow normally goes via the CN connector
      return symbol.startsWith('6') ? `${symbol}.SS` : `${symbol}.SZ`;
    default:
      return symbol;
  }
}

function mapMarketState(state?: string): Quote['marketStatus'] {
  switch (state) {
    case 'REGULAR':
      return 'OPEN';
    case 'CLOSED':
    case 'POSTPOST':
      return 'CLOSED';
    case 'PRE':
    case 'PREPRE':
      return 'PRE_MARKET';
    case 'POST':
      return 'AFTER_HOURS';
    default:
      return state ? 'UNKNOWN' : undefined;
  }
}

function historyFailure(args: {
  retrievedAt: string;
  code: ResearchWarning['code'];
  message: string;
  cause?: string;
}): ResearchResult<PriceBar[]> {
  return httpFailure<PriceBar[]>(PROVIDER, [], args);
}

function failingEnvelope(args: {
  retrievedAt: string;
  code: ResearchWarning['code'];
  message: string;
  cause?: string;
}): ResearchResult<Quote> {
  return httpFailure<Quote>(PROVIDER, emptyQuote(), args);
}

function profileFailure(args: {
  retrievedAt: string;
  code: ResearchWarning['code'];
  message: string;
  cause?: string;
}): ResearchResult<CompanyProfile> {
  return httpFailure<CompanyProfile>(
    PROVIDER,
    { instrument: { instrumentId: '', market: 'US', symbol: '' } },
    args,
  );
}

/** Sentinel quote used when no data is available. Carries a price of NaN so
 *  consumers that forget to check warnings fail fast rather than silently
 *  using 0. */
function emptyQuote(): Quote {
  return {
    instrument: { instrumentId: '', market: 'US', symbol: '' },
    price: Number.NaN,
    currency: 'USD',
    timestamp: new Date(0).toISOString(),
  };
}
