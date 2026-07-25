/**
 * Phase 3.C18a — CN A-share quote connector, ported from agent's
 * `quoteSnapshotCN` (tencent qt.gtimg.cn → eastmoney push2.eastmoney.com
 * fallback). Lives in research-core directly (no apps/api adapter) to
 * complete A3 terminal direction (PRD §7.3): agent depends on
 * research-core, not the other way around.
 *
 * Differences from the agent source:
 *   - Input is `instrumentId` (e.g. `CN:600519`), not `{symbol, market}`.
 *   - Exchange (SS / SZ) is inferred from the 6-digit code rather than
 *     a Yahoo suffix; callers using `parseYahooSymbol` already do this
 *     mapping themselves.
 *   - Failures are returned as structured warnings instead of thrown
 *     exceptions (PRD §14 strict=false default).
 */
import type { InstrumentRef } from '../../contracts/instrument';
import { RESEARCH_SCHEMA_VERSION, type ResearchResult } from '../../contracts/result';
import type { ResearchCitation } from '../../contracts/research-citation';
import type { ResearchWarning } from '../../contracts/warning';
import type {
  CompanyProfile,
  ConsensusEpsBundle,
  ConsensusEpsInput,
  ConsensusEpsRow,
  EarningsConsensusBundle,
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
import { CN_BROWSER_HEADERS, type Exchange, inferExchange } from '../cn-common';

const PROVIDER = 'cn';
const DEFAULT_TIMEOUT_MS = 5_000;

/**
 * Headers for the F10 基本资料 endpoint. emweb (the F10 web UI host) gates the
 * securities/api/data path on a matching Referer; the broader CN_BROWSER_HEADERS
 * Referer-less request is rejected. UA Mozilla/5.0 + the emweb Referer is the
 * combination verified live (2026-05-30).
 */
const CN_PROFILE_HEADERS: Record<string, string> = {
  'User-Agent': 'Mozilla/5.0',
  Referer: 'https://emweb.securities.eastmoney.com/',
};

/**
 * Tencent text protocol returns `v_sh600519="1~贵州茅台~..."` with 88 tilde-
 * separated fields. Field positions are stable across the Tencent rollout
 * but extremely sensitive to typos. Field map (plan-v2 §5.1):
 *
 *   [3]  当前价 (price)
 *   [4]  昨收
 *   [5]  开盘价
 *   [6]  成交量 (手)
 *   [9]  成交额 (万元)
 *   [31] 涨跌额
 *   [32] 涨跌幅%
 *   [33] 当日最高
 *   [34] 当日最低
 *   [36] 总成交量 (手, 同 6)
 *   [37] 总成交额 (万元)
 *   [38] 换手率%
 *   [39] PE (TTM)
 *   [41] 52周最高
 *   [42] 52周最低
 *   [43] 振幅%
 *   [44] 流通市值 (亿元)
 *   [45] 总市值 (亿元)
 *   [46] 市净率
 *   [49] 委比%
 *   [52] 量比
 *   [57] 总股本 (万股? 实测 6 月数据为亿股，需要 fixture 校验)
 *   [72] 流通股本 (同上)
 *
 * Numeric parsing helpers tolerate Tencent's "0.00" / "" / "null" / "-".
 */
const TENCENT_PRICE_FIELD = 3;
const TENCENT_PREV_CLOSE_FIELD = 4;
const TENCENT_DAY_OPEN_FIELD = 5;
// Field 30 is the last-trade datetime, format YYYYMMDDHHMMSS in Beijing time
// (UTC+8), e.g. "20260529161409" → 2026-05-29 16:14:09 +08:00.
const TENCENT_TIME_FIELD = 30;
const TENCENT_CHANGE_FIELD = 31;
const TENCENT_CHANGE_PCT_FIELD = 32;
const TENCENT_DAY_HIGH_FIELD = 33;
const TENCENT_DAY_LOW_FIELD = 34;
const TENCENT_VOLUME_FIELD = 36;
const TENCENT_TURNOVER_FIELD = 37;
const TENCENT_TURNOVER_RATE_FIELD = 38;
const TENCENT_PE_FIELD = 39;
const TENCENT_WEEK52_HIGH_FIELD = 41;
const TENCENT_WEEK52_LOW_FIELD = 42;
const TENCENT_AMPLITUDE_FIELD = 43;
const TENCENT_FLOAT_MCAP_FIELD = 44;
const TENCENT_MARKET_CAP_FIELD = 45;
const TENCENT_PB_FIELD = 46;
const TENCENT_BID_ASK_FIELD = 49;
const TENCENT_VOLUME_RATIO_FIELD = 52;
const TENCENT_SHARES_TOTAL_FIELD = 57;
const TENCENT_SHARES_FLOAT_FIELD = 72;
const TENCENT_MIN_FIELDS = 80;

interface QuoteFetchOk {
  ok: true;
  data: {
    price: number;
    marketCap?: number;
    peRatio?: number;
    pbRatio?: number;
    dayOpen?: number;
    dayHigh?: number;
    dayLow?: number;
    previousClose?: number;
    change?: number;
    changePct?: number;
    volume?: number;
    turnover?: number;
    turnoverRate?: number;
    amplitude?: number;
    week52High?: number;
    week52Low?: number;
    floatMarketCap?: number;
    bidAskRatio?: number;
    volumeRatio?: number;
    sharesTotal?: number;
    sharesFloat?: number;
    /** Real last-trade time (ISO), parsed from the tencent datetime field. */
    tradeTime?: string;
  };
  citation: ResearchCitation;
}
interface QuoteFetchErr {
  ok: false;
  message: string;
  code: ResearchWarning['code'];
  retryAfterMs?: number;
}
type QuoteFetchResult = QuoteFetchOk | QuoteFetchErr;

export interface CnFinanceOptions {
  /** Default fetchLike if caller didn't pass one per-request. */
  fetchLike?: FetchLike;
  /** Ordered source attempt list; defaults to ['tencent', 'eastmoney']. */
  sources?: ReadonlyArray<'tencent' | 'eastmoney'>;
}

export function createCnFinanceConnector(options: CnFinanceOptions = {}): FinancePort {
  const sources = options.sources ?? (['tencent', 'eastmoney'] as const);

  return {
    async getQuote(input: QuoteInput, ctx: ConnectorRunContext = {}): Promise<ResearchResult<Quote>> {
      const retrievedAt = new Date().toISOString();
      const parsed = parseInstrumentId(input.instrumentId);
      if (!parsed) {
        return quoteFailure(retrievedAt, 'INVALID_INSTRUMENT', `Invalid instrumentId: ${input.instrumentId}`);
      }
      if (parsed.market !== 'CN') {
        return quoteFailure(
          retrievedAt,
          'UNSUPPORTED_MARKET',
          `CN finance connector only handles CN; got ${parsed.market}`,
        );
      }
      const exchange = inferExchange(parsed.symbol);
      if (!exchange) {
        return quoteFailure(retrievedAt, 'INVALID_INSTRUMENT', `Cannot infer CN exchange for symbol ${parsed.symbol}`);
      }

      const fetchLike = resolveFetch(ctx, options);

      const attempted: { source: string; message: string }[] = [];
      const warnings: ResearchWarning[] = [];

      for (const source of sources) {
        const out = await fetchQuote(source, parsed.symbol, exchange, fetchLike, ctx, retrievedAt);
        if (!out.ok && out.code === 'RATE_LIMITED') {
          // 429 is a backoff hint, not a "try the next source". Short-circuit
          // so the caller can apply retry-after without fanning out and
          // collecting more rate-limits.
          warnings.push({
            code: out.code,
            message: `${source}: ${out.message}`,
            provider: source,
            ...(out.retryAfterMs ? { retryAfterMs: out.retryAfterMs } : {}),
          });
          return {
            schemaVersion: RESEARCH_SCHEMA_VERSION,
            data: {
              instrument: { instrumentId: parsed.raw, market: 'CN', symbol: parsed.symbol },
              price: Number.NaN,
              currency: 'CNY',
              timestamp: retrievedAt,
            },
            citations: [],
            freshness: [{ provider: PROVIDER, asOf: retrievedAt, retrievedAt, stale: true, reason: 'rate limited' }],
            warnings,
          };
        }
        if (out.ok) {
          const quote: Quote = {
            instrument: {
              instrumentId: parsed.raw,
              market: 'CN',
              symbol: parsed.symbol,
              currency: 'CNY',
              exchange: exchange === 'SS' ? 'SSE' : exchange === 'SZ' ? 'SZSE' : 'BSE',
            },
            price: out.data.price,
            currency: 'CNY',
            // Prefer the real last-trade time (enables holiday-aware market
            // state downstream); fall back to fetch time when unparseable.
            timestamp: out.data.tradeTime ?? retrievedAt,
            ...(out.data.marketCap !== undefined ? { marketCap: out.data.marketCap } : {}),
            ...(out.data.peRatio !== undefined ? { peRatio: out.data.peRatio } : {}),
            ...(out.data.pbRatio !== undefined ? { pbRatio: out.data.pbRatio } : {}),
            ...(out.data.dayOpen !== undefined ? { dayOpen: out.data.dayOpen } : {}),
            ...(out.data.dayHigh !== undefined ? { dayHigh: out.data.dayHigh } : {}),
            ...(out.data.dayLow !== undefined ? { dayLow: out.data.dayLow } : {}),
            ...(out.data.previousClose !== undefined ? { previousClose: out.data.previousClose } : {}),
            ...(out.data.change !== undefined ? { change: out.data.change } : {}),
            ...(out.data.changePct !== undefined ? { changePct: out.data.changePct } : {}),
            ...(out.data.volume !== undefined ? { volume: out.data.volume } : {}),
            ...(out.data.turnover !== undefined ? { turnover: out.data.turnover } : {}),
            ...(out.data.turnoverRate !== undefined ? { turnoverRate: out.data.turnoverRate } : {}),
            ...(out.data.amplitude !== undefined ? { amplitude: out.data.amplitude } : {}),
            ...(out.data.week52High !== undefined ? { week52High: out.data.week52High } : {}),
            ...(out.data.week52Low !== undefined ? { week52Low: out.data.week52Low } : {}),
            ...(out.data.floatMarketCap !== undefined ? { floatMarketCap: out.data.floatMarketCap } : {}),
            ...(out.data.bidAskRatio !== undefined ? { bidAskRatio: out.data.bidAskRatio } : {}),
            ...(out.data.volumeRatio !== undefined ? { volumeRatio: out.data.volumeRatio } : {}),
            ...(out.data.sharesTotal !== undefined ? { sharesTotal: out.data.sharesTotal } : {}),
            ...(out.data.sharesFloat !== undefined ? { sharesFloat: out.data.sharesFloat } : {}),
          };
          return {
            schemaVersion: RESEARCH_SCHEMA_VERSION,
            data: quote,
            citations: [out.citation],
            freshness: [{ provider: PROVIDER, asOf: retrievedAt, retrievedAt, stale: false }],
            warnings,
          };
        }
        attempted.push({ source, message: out.message });
        warnings.push({
          code: out.code,
          message: `${source}: ${out.message}`,
          provider: source,
          ...(out.retryAfterMs ? { retryAfterMs: out.retryAfterMs } : {}),
        });
      }

      warnings.push({
        code: 'SOURCE_UNAVAILABLE',
        message: `cn quote exhausted sources: ${attempted.map((a) => a.source).join(',')}`,
        provider: PROVIDER,
        cause: attempted.map((a) => `${a.source}: ${a.message}`).join('; '),
      });
      return {
        schemaVersion: RESEARCH_SCHEMA_VERSION,
        data: {
          instrument: { instrumentId: parsed.raw, market: 'CN', symbol: parsed.symbol },
          price: Number.NaN,
          currency: 'CNY',
          timestamp: retrievedAt,
        },
        citations: [],
        freshness: [{ provider: PROVIDER, asOf: retrievedAt, retrievedAt, stale: true, reason: 'all sources failed' }],
        warnings,
      };
    },

    async getHistory(input: HistoryInput, ctx: ConnectorRunContext = {}): Promise<ResearchResult<PriceBar[]>> {
      // Hotfix (2026-05-25): Was a stub returning empty bars + PARTIAL_DATA.
      // Now wired to Eastmoney push2his kline endpoint (same source that
      // backs the quote.eastmoney.com chart UI). Format: pipe-separated
      // string-per-day in `data.klines[]` with `data.decimal` for scale.
      const retrievedAt = new Date().toISOString();
      const parsed = parseInstrumentId(input.instrumentId);
      if (!parsed || parsed.market !== 'CN') {
        return historyFailure(retrievedAt, 'INVALID_INSTRUMENT', `expected CN instrumentId, got ${input.instrumentId}`);
      }
      const exchange = inferExchange(parsed.symbol);
      if (!exchange) {
        return historyFailure(retrievedAt, 'INVALID_INSTRUMENT', `Cannot infer CN exchange for symbol ${parsed.symbol}`);
      }
      const mktNum = exchange === 'SS' ? '1' : exchange === 'SZ' ? '0' : '0'; // BJ also uses 0 in this API
      const secid = `${mktNum}.${parsed.symbol}`;
      const beg = input.from.replace(/-/g, '');
      const end = input.to.replace(/-/g, '');
      // Eastmoney 历史 K 线官方端点。push2.eastmoney.com 是实时行情，不带
      // 历史数据；push2his.eastmoney.com 才是历史 kline 数据源。该端点
      // 有时会触发 WAF（连续 burst 测试时返回 empty reply），生产用 24h
      // 缓存可避免；测试时如果撞 WAF 需等 ~1h 解封。
      const url =
        `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secid}` +
        `&klt=101&fqt=1&beg=${beg}&end=${end}` +
        `&fields1=f1,f2,f3,f4,f5&fields2=f51,f52,f53,f54,f55,f56,f57,f58`;

      const fetchLike = resolveFetch(ctx, options);
      const timeoutMs = ctx.timeoutMs ?? DEFAULT_TIMEOUT_MS;

      try {
        return await withTimeout(ctx, timeoutMs, async (signal) => {
        const res = await fetchLike(url, { headers: CN_BROWSER_HEADERS, signal });
        if (!res.ok) {
          if (res.status === 429) return historyFailure(retrievedAt, 'RATE_LIMITED', `HTTP 429`);
          return historyFailure(retrievedAt, 'SOURCE_UNAVAILABLE', `Eastmoney kline HTTP ${res.status}`);
        }
        const body = res.text ? await res.text() : JSON.stringify(await res.json());
        let parsedJson: unknown;
        try {
          parsedJson = JSON.parse(body);
        } catch {
          return historyFailure(retrievedAt, 'PARTIAL_DATA', 'Eastmoney kline JSON parse failed');
        }
        const payload = (parsedJson as { data?: { klines?: unknown[] } })?.data;
        const klines = payload?.klines;
        if (!Array.isArray(klines) || klines.length === 0) {
          return historyFailure(retrievedAt, 'PARTIAL_DATA', 'Eastmoney kline returned empty');
        }
        const bars: PriceBar[] = [];
        for (const raw of klines) {
          if (typeof raw !== 'string') continue;
          const parts = raw.split(',');
          // f51..f58: date, open, close, high, low, volume, amount, change_pct
          if (parts.length < 7) continue;
          const [date, open, close, high, low, volume] = parts;
          const o = Number(open), c = Number(close), h = Number(high), l = Number(low), v = Number(volume);
          if (!Number.isFinite(o) || !Number.isFinite(c)) continue;
          bars.push({
            timestamp: date,
            open: o,
            close: c,
            high: Number.isFinite(h) ? h : c,
            low: Number.isFinite(l) ? l : c,
            ...(Number.isFinite(v) ? { volume: v } : {}),
          });
        }
        if (bars.length === 0) {
          return historyFailure(retrievedAt, 'PARTIAL_DATA', 'all kline rows failed to parse');
        }
        const citation: ResearchCitation = {
          title: `Eastmoney K线: ${parsed.symbol}`,
          url: `https://quote.eastmoney.com/${exchange === 'SS' ? 'sh' : exchange === 'SZ' ? 'sz' : 'bj'}${parsed.symbol}.html`,
          sourceType: 'PRICE',
          provider: PROVIDER,
          retrievedAt,
          qualityTier: 'B',
        };
        return {
          schemaVersion: RESEARCH_SCHEMA_VERSION,
          data: bars,
          citations: [citation],
          freshness: [{ provider: PROVIDER, asOf: retrievedAt, retrievedAt, stale: false }],
          warnings: [],
        };
        });
      } catch (err) {
        const message = (err as Error)?.message ?? String(err);
        return historyFailure(retrievedAt, 'SOURCE_UNAVAILABLE', `Eastmoney kline fetch error: ${message}`);
      }
    },

    async fetchConsensusEps(
      input: ConsensusEpsInput,
      ctx: ConnectorRunContext = {},
    ): Promise<ResearchResult<ConsensusEpsBundle | null>> {
      const retrievedAt = new Date().toISOString();
      const parsed = parseInstrumentId(input.instrumentId);
      if (!parsed) {
        return consensusEpsFailure(
          retrievedAt,
          'INVALID_INSTRUMENT',
          `Invalid instrumentId: ${input.instrumentId}`,
        );
      }
      if (parsed.market !== 'CN') {
        return consensusEpsFailure(
          retrievedAt,
          'UNSUPPORTED_MARKET',
          `consensusEps connector only handles CN; got ${parsed.market}`,
        );
      }
      const fetchLike = resolveFetch(ctx, options);
      const out = await fetchEastmoneyConsensusEps(parsed.symbol, fetchLike, ctx, retrievedAt);
      if (out.ok) {
        return {
          schemaVersion: RESEARCH_SCHEMA_VERSION,
          data: out.bundle,
          citations: [out.citation],
          freshness: [{ provider: PROVIDER, asOf: retrievedAt, retrievedAt, stale: false }],
          warnings: [],
        };
      }
      // Connector treats "no forecast rows" as data=null + stale freshness
      // marker rather than a warning. Builder propagates this as missing
      // silently per RFC §1 (consensusEps is augmenter-fallback eligible).
      if (out.code === 'NO_DATA') {
        return {
          schemaVersion: RESEARCH_SCHEMA_VERSION,
          data: null,
          citations: [],
          freshness: [
            { provider: PROVIDER, asOf: retrievedAt, retrievedAt, stale: true, reason: 'no forecast rows' },
          ],
          warnings: [],
        };
      }
      return {
        schemaVersion: RESEARCH_SCHEMA_VERSION,
        data: null,
        citations: [],
        freshness: [{ provider: PROVIDER, asOf: retrievedAt, retrievedAt, stale: true, reason: out.message }],
        warnings: [
          {
            code: out.code,
            message: out.message,
            provider: PROVIDER,
            ...(out.retryAfterMs ? { retryAfterMs: out.retryAfterMs } : {}),
          },
        ],
      };
    },

    async fetchEarningsConsensus(
      input: ConsensusEpsInput,
      ctx: ConnectorRunContext = {},
    ): Promise<ResearchResult<EarningsConsensusBundle | null>> {
      const retrievedAt = new Date().toISOString();
      const parsed = parseInstrumentId(input.instrumentId);
      if (!parsed || parsed.market !== 'CN') {
        return httpFailure<EarningsConsensusBundle | null>(PROVIDER, null, {
          retrievedAt,
          code: parsed ? 'UNSUPPORTED_MARKET' : 'INVALID_INSTRUMENT',
          message: parsed
            ? `earnings consensus connector only handles CN; got ${parsed.market}`
            : `Invalid instrumentId: ${input.instrumentId}`,
        });
      }
      const out = await fetchEastmoneyConsensusEps(
        parsed.symbol,
        resolveFetch(ctx, options),
        ctx,
        retrievedAt,
      );
      if (!out.ok) {
        return {
          schemaVersion: RESEARCH_SCHEMA_VERSION,
          data: null,
          citations: [],
          freshness: [{ provider: PROVIDER, asOf: retrievedAt, retrievedAt, stale: true, reason: out.message }],
          warnings: out.code === 'NO_DATA' ? [] : [{ code: out.code, message: out.message, provider: PROVIDER }],
        };
      }
      return {
        schemaVersion: RESEARCH_SCHEMA_VERSION,
        data: {
          asOf: out.bundle.asOf,
          estimates: out.bundle.forecasts.map((forecast) => ({
            metricCode: 'epsBasic' as const,
            periodEndOn: `${forecast.year}-12-31`,
            periodType: 'FY' as const,
            value: forecast.value.toString(),
            unit: 'per_share' as const,
            currency: 'CNY',
            ...(out.bundle.analystCount > 0 ? { analystCount: out.bundle.analystCount } : {}),
          })),
        },
        citations: [out.citation],
        freshness: [{ provider: PROVIDER, asOf: out.bundle.asOf, retrievedAt, stale: false }],
        warnings: [],
      };
    },

    async getProfile(
      input: ProfileInput,
      ctx: ConnectorRunContext = {},
    ): Promise<ResearchResult<CompanyProfile>> {
      const retrievedAt = new Date().toISOString();
      const parsed = parseInstrumentId(input.instrumentId);
      if (!parsed) {
        return profileFailure(retrievedAt, 'INVALID_INSTRUMENT', `Invalid instrumentId: ${input.instrumentId}`);
      }
      if (parsed.market !== 'CN') {
        return profileFailure(
          retrievedAt,
          'UNSUPPORTED_MARKET',
          `CN finance connector only handles CN; got ${parsed.market}`,
        );
      }
      const exchange = inferExchange(parsed.symbol);
      if (!exchange) {
        return profileFailure(retrievedAt, 'INVALID_INSTRUMENT', `Cannot infer CN exchange for symbol ${parsed.symbol}`);
      }
      const fetchLike = resolveFetch(ctx, options);
      const out = await fetchEastmoneyProfile(parsed.symbol, exchange, fetchLike, ctx, retrievedAt);
      const instrument: InstrumentRef = {
        instrumentId: parsed.raw,
        market: 'CN',
        symbol: parsed.symbol,
        currency: 'CNY',
        exchange: exchange === 'SS' ? 'SSE' : exchange === 'SZ' ? 'SZSE' : 'BSE',
      };
      if (out.ok) {
        return {
          schemaVersion: RESEARCH_SCHEMA_VERSION,
          data: { instrument, ...out.profile },
          citations: [out.citation],
          freshness: [{ provider: PROVIDER, asOf: retrievedAt, retrievedAt, stale: false }],
          warnings: [],
        };
      }
      // NO_DATA (non-array / code 9201) → return a profile with just the
      // instrument, no warning (consistent with the consensus-eps NO_DATA path
      // and the financial-statement empty-result handling).
      if (out.code === 'NO_DATA') {
        return {
          schemaVersion: RESEARCH_SCHEMA_VERSION,
          data: { instrument },
          citations: [],
          freshness: [{ provider: PROVIDER, asOf: retrievedAt, retrievedAt, stale: true, reason: 'no profile row' }],
          warnings: [],
        };
      }
      return profileFailure(retrievedAt, out.code, out.message);
    },
  };
}

// ─── Source fetchers ──────────────────────────────────────────────────────

async function fetchQuote(
  source: 'tencent' | 'eastmoney',
  symbol: string,
  exchange: Exchange,
  fetchLike: FetchLike,
  ctx: ConnectorRunContext,
  retrievedAt: string,
): Promise<QuoteFetchResult> {
  const timeoutMs = ctx.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  try {
    return await withTimeout(ctx, timeoutMs, (signal) => {
      if (source === 'tencent') return fetchTencent(symbol, exchange, fetchLike, signal, retrievedAt);
      return fetchEastmoney(symbol, exchange, fetchLike, signal, retrievedAt);
    });
  } catch (err) {
    const message = (err as Error)?.message ?? String(err);
    return { ok: false, code: 'SOURCE_UNAVAILABLE', message };
  }
}

async function fetchTencent(
  symbol: string,
  exchange: Exchange,
  fetchLike: FetchLike,
  signal: AbortSignal,
  retrievedAt: string,
): Promise<QuoteFetchResult> {
  const tencentPrefix = exchange === 'SS' ? 'sh' : exchange === 'SZ' ? 'sz' : 'bj';
  const tencentSymbol = `${tencentPrefix}${symbol}`;
  const url = `https://qt.gtimg.cn/q=${tencentSymbol}`;
  const res = await fetchLike(url, { headers: CN_BROWSER_HEADERS, signal });
  if (!res.ok) {
    if (res.status === 429) {
      return { ok: false, code: 'RATE_LIMITED', message: `HTTP 429`, retryAfterMs: 30_000 };
    }
    return { ok: false, code: 'SOURCE_UNAVAILABLE', message: `HTTP ${res.status}` };
  }
  // tencent returns text/javascript like `v_sh600519="..."`. FetchLike.text
  // is optional; if the stub doesn't implement it (older tests) we error
  // out gracefully.
  if (!res.text) {
    return { ok: false, code: 'SOURCE_UNAVAILABLE', message: 'tencent: FetchLike.text() not provided' };
  }
  const body = await res.text();
  const match = body.match(/="([^"]*)"/);
  if (!match) return { ok: false, code: 'SOURCE_UNAVAILABLE', message: 'tencent: unrecognized shape' };
  const fields = match[1].split('~');
  if (fields.length < TENCENT_MIN_FIELDS) {
    return { ok: false, code: 'SOURCE_UNAVAILABLE', message: `tencent: too few fields (${fields.length})` };
  }
  const price = parseFloat(fields[TENCENT_PRICE_FIELD]);
  const marketCap = parseFloat(fields[TENCENT_MARKET_CAP_FIELD]);
  if (!Number.isFinite(price) || price <= 0) {
    return { ok: false, code: 'SOURCE_UNAVAILABLE', message: `tencent: invalid price "${fields[TENCENT_PRICE_FIELD]}"` };
  }
  if (!Number.isFinite(marketCap) || marketCap <= 0) {
    return { ok: false, code: 'SOURCE_UNAVAILABLE', message: `tencent: invalid marketCap` };
  }

  // Extended fields — each silently downgrades to undefined when malformed.
  // Tencent expresses percentages as raw % (e.g. "1.23" = 1.23%); the Quote
  // contract uses decimal fractions so we divide by 100 where applicable.
  const peRatio = pickNumberSafe(fields[TENCENT_PE_FIELD]);
  const pbRatio = pickNumberSafe(fields[TENCENT_PB_FIELD]);
  const dayOpen = pickNumberSafe(fields[TENCENT_DAY_OPEN_FIELD]);
  const dayHigh = pickNumberSafe(fields[TENCENT_DAY_HIGH_FIELD]);
  const dayLow = pickNumberSafe(fields[TENCENT_DAY_LOW_FIELD]);
  const previousClose = pickNumberSafe(fields[TENCENT_PREV_CLOSE_FIELD]);
  const change = pickNumberSafe(fields[TENCENT_CHANGE_FIELD]);
  const changePctRaw = pickNumberSafe(fields[TENCENT_CHANGE_PCT_FIELD]);
  const changePct = changePctRaw !== undefined ? changePctRaw / 100 : undefined;
  const volume = pickNumberSafe(fields[TENCENT_VOLUME_FIELD]); // 手 (1 手=100 股)
  // 成交额 in 万元 → convert to 元 for consistency with Quote.turnover unit doc
  const turnoverWan = pickNumberSafe(fields[TENCENT_TURNOVER_FIELD]);
  const turnover = turnoverWan !== undefined ? turnoverWan * 10_000 : undefined;
  const turnoverRateRaw = pickNumberSafe(fields[TENCENT_TURNOVER_RATE_FIELD]);
  const turnoverRate = turnoverRateRaw !== undefined ? turnoverRateRaw / 100 : undefined;
  const amplitudeRaw = pickNumberSafe(fields[TENCENT_AMPLITUDE_FIELD]);
  const amplitude = amplitudeRaw !== undefined ? amplitudeRaw / 100 : undefined;
  const week52High = pickNumberSafe(fields[TENCENT_WEEK52_HIGH_FIELD]);
  const week52Low = pickNumberSafe(fields[TENCENT_WEEK52_LOW_FIELD]);
  const floatMarketCap = pickNumberSafe(fields[TENCENT_FLOAT_MCAP_FIELD]);
  const bidAskRaw = pickNumberSafe(fields[TENCENT_BID_ASK_FIELD]);
  const bidAskRatio = bidAskRaw !== undefined ? bidAskRaw / 100 : undefined;
  const volumeRatio = pickNumberSafe(fields[TENCENT_VOLUME_RATIO_FIELD]);
  const sharesTotal = pickNumberSafe(fields[TENCENT_SHARES_TOTAL_FIELD]);
  const sharesFloat = pickNumberSafe(fields[TENCENT_SHARES_FLOAT_FIELD]);
  const tradeTime = parseTencentTime(fields[TENCENT_TIME_FIELD]);

  return {
    ok: true,
    data: {
      price,
      marketCap,
      peRatio,
      pbRatio,
      dayOpen,
      dayHigh,
      dayLow,
      previousClose,
      change,
      changePct,
      volume,
      turnover,
      turnoverRate,
      amplitude,
      week52High,
      week52Low,
      floatMarketCap,
      bidAskRatio,
      volumeRatio,
      sharesTotal,
      sharesFloat,
      ...(tradeTime ? { tradeTime } : {}),
    },
    citation: {
      title: `腾讯财经行情 ${symbol}`,
      url,
      sourceType: 'OTHER',
      provider: 'tencent',
      retrievedAt,
      qualityTier: 'B',
    },
  };
}

function pickNumberSafe(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed === 'null' || trimmed === '-') return undefined;
  const n = parseFloat(trimmed);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Parse the tencent last-trade datetime field (`YYYYMMDDHHMMSS`, Beijing time)
 * into an ISO string. Returns undefined for malformed values so callers fall
 * back to the fetch time. The `+08:00` offset is fixed (CN has no DST).
 */
function parseTencentTime(raw: string | undefined): string | undefined {
  const m = raw?.trim().match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/);
  if (!m) return undefined;
  const [, y, mo, d, h, mi, s] = m;
  const date = new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}+08:00`);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

async function fetchEastmoney(
  symbol: string,
  exchange: Exchange,
  fetchLike: FetchLike,
  signal: AbortSignal,
  retrievedAt: string,
): Promise<QuoteFetchResult> {
  const prefix = exchange === 'SS' ? '1' : '0';
  const secid = `${prefix}.${symbol}`;
  const fields = 'f43,f116,f9';
  const url = `https://push2.eastmoney.com/api/qt/stock/get?secid=${secid}&fields=${fields}`;
  const res = await fetchLike(url, { headers: CN_BROWSER_HEADERS, signal });
  if (!res.ok) {
    if (res.status === 429) {
      return { ok: false, code: 'RATE_LIMITED', message: `HTTP 429`, retryAfterMs: 30_000 };
    }
    return { ok: false, code: 'SOURCE_UNAVAILABLE', message: `HTTP ${res.status}` };
  }
  const data = (await res.json()) as { data?: Record<string, unknown> };
  const payload = data?.data;
  if (!payload) return { ok: false, code: 'PARTIAL_DATA', message: 'eastmoney: missing data field' };
  const rawPrice = payload.f43;
  const rawMc = payload.f116;
  const rawPe = payload.f9;
  const price = typeof rawPrice === 'number' ? rawPrice : NaN;
  const marketCapYuan = typeof rawMc === 'number' ? rawMc : NaN;
  const peRatio = typeof rawPe === 'number' && rawPe > 0 ? rawPe : undefined;
  if (!Number.isFinite(price) || price <= 0) {
    return { ok: false, code: 'SOURCE_UNAVAILABLE', message: `eastmoney: invalid f43` };
  }
  if (!Number.isFinite(marketCapYuan) || marketCapYuan <= 0) {
    return { ok: false, code: 'SOURCE_UNAVAILABLE', message: 'eastmoney: invalid f116' };
  }
  return {
    ok: true,
    data: { price, marketCap: marketCapYuan / 1e8, peRatio },
    citation: {
      title: `东方财富行情 ${symbol}`,
      url,
      sourceType: 'OTHER',
      provider: 'eastmoney',
      retrievedAt,
      qualityTier: 'B',
    },
  };
}

// ─── Consensus EPS (Eastmoney datacenter) ────────────────────────────────

interface ConsensusEpsFetchOk {
  ok: true;
  bundle: ConsensusEpsBundle;
  citation: ResearchCitation;
}
interface ConsensusEpsFetchErr {
  ok: false;
  code: ResearchWarning['code'] | 'NO_DATA';
  message: string;
  retryAfterMs?: number;
}
type ConsensusEpsFetchResult = ConsensusEpsFetchOk | ConsensusEpsFetchErr;

async function fetchEastmoneyConsensusEps(
  symbol: string,
  fetchLike: FetchLike,
  ctx: ConnectorRunContext,
  retrievedAt: string,
): Promise<ConsensusEpsFetchResult> {
  const timeoutMs = ctx.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  try {
    return await withTimeout(ctx, timeoutMs, async (signal) => {
    // Hotfix (2026-05-25): Eastmoney removed RPT_RES_CONFORECASTPREDATA
    // ("报表配置不存在"). Switched to RPT_RES_PROFITPREDICT which exposes
    // the same headline values (PREDICT_YEAR + EPS) plus PE / PARENT_NETPROFIT
    // / TOTAL_OPERATE_INCOME. NUM_OF_ORG (analyst count) is no longer
    // exposed — bundle.analystCount becomes 0 (unknown) for CN.
    const url =
      `https://datacenter-web.eastmoney.com/api/data/v1/get?` +
      `reportName=RPT_RES_PROFITPREDICT` +
      `&columns=SECUCODE,SECURITY_CODE,PREDICT_YEAR,EPS,PE,PARENT_NETPROFIT,TOTAL_OPERATE_INCOME` +
      `&pageNumber=1&pageSize=10` +
      `&sortColumns=PREDICT_YEAR&sortTypes=1` +
      `&filter=(SECURITY_CODE%3D%22${symbol}%22)`;
    const res = await fetchLike(url, { headers: CN_BROWSER_HEADERS, signal });
    if (!res.ok) {
      if (res.status === 429) {
        return { ok: false, code: 'RATE_LIMITED', message: 'HTTP 429', retryAfterMs: 30_000 };
      }
      return { ok: false, code: 'SOURCE_UNAVAILABLE', message: `eastmoney HTTP ${res.status}` };
    }
    let parsed: unknown;
    if (res.text) {
      const body = await res.text();
      try {
        parsed = JSON.parse(body);
      } catch {
        return { ok: false, code: 'PARTIAL_DATA', message: 'eastmoney: JSON parse failed' };
      }
    } else {
      parsed = await res.json();
    }
    const root = parsed as { result?: { data?: unknown } | null; success?: boolean; message?: string };
    // datacenter API returns `success: false` + null result on bad reportName.
    if (root?.success === false) {
      return { ok: false, code: 'PARTIAL_DATA', message: `eastmoney: ${root.message ?? 'reportName invalid'}` };
    }
    const rows = root?.result?.data;
    if (!Array.isArray(rows)) {
      return { ok: false, code: 'PARTIAL_DATA', message: 'eastmoney: missing result.data array' };
    }
    const forecasts: ConsensusEpsRow[] = [];
    for (const r of rows) {
      if (!r || typeof r !== 'object') continue;
      const o = r as Record<string, unknown>;
      const year = pickIntField(o.PREDICT_YEAR);
      const value = pickFloatField(o.EPS);
      if (year === null || value === null) continue;
      forecasts.push({ year, value });
    }
    // RPT_RES_PROFITPREDICT doesn't expose analyst count — leave at 0.
    const analystCount = 0;
    if (forecasts.length === 0) {
      return { ok: false, code: 'NO_DATA', message: 'no parseable forecast rows' };
    }
    forecasts.sort((a, b) => a.year - b.year);
    const avgEps = forecasts[0].value; // nearest forward year is the headline
    return {
      ok: true,
      bundle: {
        avgEps,
        analystCount,
        asOf: retrievedAt,
        forecasts,
      },
      citation: {
        title: `东方财富 一致预期 ${symbol}`,
        url,
        sourceType: 'OTHER',
        provider: 'eastmoney',
        retrievedAt,
        qualityTier: 'B',
      },
    };
    });
  } catch (err) {
    const message = (err as Error)?.message ?? String(err);
    return { ok: false, code: 'SOURCE_UNAVAILABLE', message };
  }
}

// ─── Company profile (Eastmoney F10 RPT_F10_BASIC_ORGINFO) ───────────────

interface ProfileFetchOk {
  ok: true;
  /** CompanyProfile minus `instrument` (the caller stamps that). */
  profile: Omit<CompanyProfile, 'instrument'>;
  citation: ResearchCitation;
}
interface ProfileFetchErr {
  ok: false;
  code: ResearchWarning['code'] | 'NO_DATA';
  message: string;
}
type ProfileFetchResult = ProfileFetchOk | ProfileFetchErr;

/** Map the canonical exchange enum to the SECUCODE suffix F10 expects. */
function secucodeSuffix(exchange: Exchange): string {
  return exchange === 'SS' ? 'SH' : exchange === 'SZ' ? 'SZ' : 'BJ';
}

/**
 * Fetch Eastmoney F10 基本资料 (RPT_F10_BASIC_ORGINFO). Live-confirmed fields
 * (2026-05-30, 600519):
 *   ORG_PROFILE → description
 *   EM2016 = "食品饮料-饮料-白酒" → sector = split('-')[0], industry = split('-').pop()
 *   ORG_WEB → website (no scheme; left as-is)
 *   EMP_NUM → employees (may be number or string)
 * marketCap is not in this report — quote supplies it elsewhere.
 *
 * Filter is SECUCODE (needs the .SH/.SZ/.BJ suffix), not SECURITY_CODE.
 */
async function fetchEastmoneyProfile(
  symbol: string,
  exchange: Exchange,
  fetchLike: FetchLike,
  ctx: ConnectorRunContext,
  retrievedAt: string,
): Promise<ProfileFetchResult> {
  const timeoutMs = ctx.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const secucode = `${symbol}.${secucodeSuffix(exchange)}`;
  const url =
    `https://datacenter.eastmoney.com/securities/api/data/v1/get?` +
    `reportName=RPT_F10_BASIC_ORGINFO&columns=ALL&pageSize=1` +
    `&filter=(SECUCODE%3D%22${secucode}%22)`;
  try {
    return await withTimeout(ctx, timeoutMs, async (signal) => {
      const res = await fetchLike(url, { headers: CN_PROFILE_HEADERS, signal });
      if (!res.ok) {
        if (res.status === 429) return { ok: false, code: 'RATE_LIMITED', message: 'HTTP 429' };
        return { ok: false, code: 'SOURCE_UNAVAILABLE', message: `eastmoney HTTP ${res.status}` };
      }
      let parsed: unknown;
      if (res.text) {
        const body = await res.text();
        try {
          parsed = JSON.parse(body);
        } catch {
          return { ok: false, code: 'PARTIAL_DATA', message: 'eastmoney: JSON parse failed' };
        }
      } else {
        parsed = await res.json();
      }
      const root = parsed as { result?: { data?: unknown }; code?: number; message?: string };
      // 9501 = report config not found → hard error (config bug, not a data gap).
      if (root?.code === 9501) {
        return { ok: false, code: 'SOURCE_UNAVAILABLE', message: `eastmoney: report config not found (${root.message ?? 'no message'})` };
      }
      const rows = root?.result?.data;
      // Non-array / 9201 (no data for this stock) → NO_DATA (just the instrument).
      if (!Array.isArray(rows) || rows.length === 0) {
        return { ok: false, code: 'NO_DATA', message: 'no profile row' };
      }
      const o = rows[0] as Record<string, unknown>;
      const description = pickStringField(o.ORG_PROFILE);
      const { sector, industry } = parseEm2016(o.EM2016);
      const website = pickStringField(o.ORG_WEB);
      const employees = pickIntField(o.EMP_NUM);
      const profile: Omit<CompanyProfile, 'instrument'> = {
        ...(description ? { description } : {}),
        ...(sector ? { sector } : {}),
        ...(industry ? { industry } : {}),
        ...(website ? { website } : {}),
        ...(employees !== null && employees >= 0 ? { employees } : {}),
      };
      return {
        ok: true,
        profile,
        citation: {
          title: `东方财富 公司资料 ${symbol}`,
          url,
          sourceType: 'OTHER',
          provider: 'eastmoney',
          retrievedAt,
          qualityTier: 'B',
        },
      };
    });
  } catch (err) {
    const message = (err as Error)?.message ?? String(err);
    return { ok: false, code: 'SOURCE_UNAVAILABLE', message };
  }
}

/** Trim + null-out blank/placeholder eastmoney strings. */
function pickStringField(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const trimmed = v.trim();
  if (trimmed === '' || trimmed === '-' || trimmed === 'null') return undefined;
  return trimmed;
}

/**
 * EM2016 is a dash-joined industry chain, e.g. "食品饮料-饮料-白酒".
 * sector = head segment, industry = leaf (most specific) segment.
 */
function parseEm2016(v: unknown): { sector?: string; industry?: string } {
  const raw = pickStringField(v);
  if (!raw) return {};
  const parts = raw.split('-').map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) return {};
  return { sector: parts[0], industry: parts[parts.length - 1] };
}

function pickIntField(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === 'string') {
    const n = parseInt(v, 10);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function pickFloatField(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = parseFloat(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function consensusEpsFailure(
  retrievedAt: string,
  code: ResearchWarning['code'],
  message: string,
): ResearchResult<ConsensusEpsBundle | null> {
  return httpFailure<ConsensusEpsBundle | null>(PROVIDER, null, { retrievedAt, code, message });
}

function historyFailure(
  retrievedAt: string,
  code: ResearchWarning['code'],
  message: string,
  cause?: string,
): ResearchResult<PriceBar[]> {
  return httpFailure<PriceBar[]>(PROVIDER, [], {
    retrievedAt,
    code,
    message,
    ...(cause ? { cause } : {}),
  });
}

function profileFailure(
  retrievedAt: string,
  code: ResearchWarning['code'],
  message: string,
): ResearchResult<CompanyProfile> {
  return httpFailure<CompanyProfile>(
    PROVIDER,
    { instrument: { instrumentId: '', market: 'CN', symbol: '' } },
    { retrievedAt, code, message },
  );
}

function quoteFailure(
  retrievedAt: string,
  code: ResearchWarning['code'],
  message: string,
  cause?: string,
): ResearchResult<Quote> {
  return httpFailure<Quote>(
    PROVIDER,
    {
      instrument: { instrumentId: '', market: 'CN', symbol: '' },
      price: Number.NaN,
      currency: 'CNY',
      timestamp: new Date(0).toISOString(),
    },
    {
      retrievedAt,
      code,
      message,
      ...(cause ? { cause } : {}),
    },
  );
}
