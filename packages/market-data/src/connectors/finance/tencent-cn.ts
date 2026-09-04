import { RESEARCH_SCHEMA_VERSION, type ResearchResult } from '../../contracts/result';
import type { ProviderFinancePort as FinancePort, HistoryInput, PriceBar, Quote, QuoteInput } from '../../ports/finance';
import { parseInstrumentId } from '../../util/instrument-id';
import { failure as httpFailure, resolveFetch, withTimeout } from '../http';
import type { ConnectorRunContext, FetchLike } from '../types';

const PROVIDER = 'tencent-cn-history';
const API_URL = 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get';
const DEFAULT_TIMEOUT_MS = 5_000;

export interface TencentCnFinanceOptions {
  fetchLike?: FetchLike;
  timeoutMs?: number;
}

export function createTencentCnFinanceConnector(
  options: TencentCnFinanceOptions = {},
): FinancePort {
  return {
    async getQuote(input: QuoteInput): Promise<ResearchResult<Quote>> {
      return quoteFailure(input.instrumentId, 'This connector only provides CN history.');
    },

    async getHistory(
      input: HistoryInput,
      ctx: ConnectorRunContext = {},
    ): Promise<ResearchResult<PriceBar[]>> {
      const retrievedAt = new Date().toISOString();
      const parsed = parseInstrumentId(input.instrumentId);
      if (!parsed || parsed.market !== 'CN') {
        return historyFailure(retrievedAt, 'INVALID_INSTRUMENT', `Expected CN instrumentId, got ${input.instrumentId}.`);
      }
      const prefix = exchangePrefix(parsed.symbol);
      if (!prefix && !ctx.resolvedInstrument) {
        return historyFailure(retrievedAt, 'INVALID_INSTRUMENT', `Cannot infer CN exchange for ${parsed.symbol}.`);
      }
      const providerSymbol = ctx.resolvedInstrument?.instrumentId === parsed.raw
        ? ctx.resolvedInstrument.providerSymbol
        : `${prefix}${parsed.symbol}`;
      const url = `${API_URL}?param=${providerSymbol},day,,,500,qfq`;
      const fetchLike = resolveFetch(ctx, options);
      try {
        return await withTimeout(ctx, ctx.timeoutMs ?? options.timeoutMs ?? DEFAULT_TIMEOUT_MS, async (signal) => {
          const response = await fetchLike(url, {
            headers: {
              Accept: 'application/json, text/plain, */*',
              Referer: 'https://gu.qq.com/',
              'User-Agent': 'Mozilla/5.0',
            },
            signal,
          });
          if (!response.ok) {
            return historyFailure(retrievedAt, response.status === 429 ? 'RATE_LIMITED' : 'SOURCE_UNAVAILABLE', `Tencent CN history HTTP ${response.status}.`);
          }
          const payload = await response.json() as {
            code?: number;
            data?: Record<string, { qfqday?: unknown[]; day?: unknown[] }>;
          };
          const node = payload.data?.[providerSymbol];
          const rows = node?.qfqday ?? node?.day ?? [];
          const bars = rows.flatMap(parseRow).filter((bar) =>
            bar.timestamp >= input.from && bar.timestamp <= input.to,
          );
          if (payload.code !== 0 || bars.length === 0) {
            return historyFailure(retrievedAt, 'PARTIAL_DATA', `Tencent returned no CN history for ${parsed.symbol}.`);
          }
          const asOf = bars.at(-1)!.timestamp;
          return {
            schemaVersion: RESEARCH_SCHEMA_VERSION,
            data: bars,
            citations: [{
              title: `Tencent Finance CN history: ${parsed.symbol}`,
              url: `https://gu.qq.com/${providerSymbol}`,
              sourceType: 'PRICE',
              provider: PROVIDER,
              retrievedAt,
              qualityTier: 'C',
            }],
            freshness: [{ provider: PROVIDER, asOf, retrievedAt, stale: false }],
            warnings: [],
          };
        });
      } catch (error) {
        return historyFailure(
          retrievedAt,
          'SOURCE_UNAVAILABLE',
          `Tencent CN history failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
  };
}

function parseRow(row: unknown): PriceBar[] {
  if (!Array.isArray(row) || row.length < 6) return [];
  const [timestamp, open, close, high, low, volume] = row;
  const values = [open, close, high, low].map(Number);
  if (typeof timestamp !== 'string' || values.some((value) => !Number.isFinite(value))) return [];
  const parsedVolume = Number(volume);
  return [{
    timestamp,
    open: values[0]!,
    close: values[1]!,
    high: values[2]!,
    low: values[3]!,
    ...(Number.isFinite(parsedVolume) ? { volume: parsedVolume } : {}),
  }];
}

function exchangePrefix(symbol: string): 'sh' | 'sz' | 'bj' | null {
  // BJ 前缀(43/83/87/88/92,与 cn-common.inferExchange 同表)必须先于
  // 9→sh 判定——否则 920xxx(北交所新代码)会被错误路由到沪市 URL。
  if (/^(43|83|87|88|92)\d{4}$/.test(symbol)) return 'bj';
  if (/^(5|6|9)/.test(symbol)) return 'sh';
  if (/^(0|1|2|3)/.test(symbol)) return 'sz';
  if (/^(4|8)/.test(symbol)) return 'bj';
  return null;
}

function historyFailure(
  retrievedAt: string,
  code: 'INVALID_INSTRUMENT' | 'SOURCE_UNAVAILABLE' | 'RATE_LIMITED' | 'PARTIAL_DATA',
  message: string,
): ResearchResult<PriceBar[]> {
  return httpFailure(PROVIDER, [], { retrievedAt, code, message });
}

function quoteFailure(instrumentId: string, message: string): ResearchResult<Quote> {
  const retrievedAt = new Date().toISOString();
  return httpFailure(PROVIDER, {
    instrument: { instrumentId, market: 'CN', symbol: instrumentId.split(':')[1] ?? instrumentId },
    price: Number.NaN,
    currency: 'CNY',
    timestamp: retrievedAt,
  }, { retrievedAt, code: 'UNSUPPORTED_MARKET', message });
}
