import { createHash } from 'node:crypto';
import { z } from 'zod';
import { RESEARCH_SCHEMA_VERSION, type ResearchResult } from '../../contracts/result';
import type { Capability, QuoteDelay, SourceManifest } from '../../contracts/source';
import type { ProviderFinancePort, Quote, PriceBar, CompanyProfile, HistoryInput } from '../../ports/finance';
import type { ConnectorRunContext, FetchLike } from '../types';
import { resolveFetch, withTimeout } from '../http';
import { historyFailure, parseFinanceInstrument, profileFailure, quoteFailure, warningCode } from '../finance/commercial-common';
import { sourceFinancePort } from '../../sources/provider-port';
import type { SourceInstance, SourcePlugin } from '../../sources/plugin';

const PROVIDER = 'massive';
const DEFAULT_API_URL = 'https://api.massive.com';
const SUPPORTED_CAPABILITIES = ['quote', 'history', 'profile'] as const;
export type MassiveCapability = (typeof SUPPORTED_CAPABILITIES)[number];
export type MassiveInterval = '1d' | '1h' | '5m' | '1m';

export interface MassiveSourceConfig {
  enabled?: boolean;
  apiKey: string;
  enabledCapabilities: readonly MassiveCapability[];
  delay: QuoteDelay;
  historyIntervals: readonly MassiveInterval[];
  requestsPerMinute?: number;
  concurrent?: number;
  apiUrl?: string;
  timeoutMs?: number;
  fetchLike?: FetchLike;
}

const LastTradeSchema = z.object({ results: z.object({ p: z.number(), s: z.number().optional(), t: z.number(), T: z.string().optional() }) });
const AggsSchema = z.object({ results: z.array(z.object({ o: z.number(), h: z.number(), l: z.number(), c: z.number(), v: z.number().optional(), t: z.number() })).default([]) });
const TickerSchema = z.object({ results: z.object({ ticker: z.string(), name: z.string().optional(), description: z.string().optional(), homepage_url: z.string().optional(), market_cap: z.number().optional(), total_employees: z.number().optional(), sic_description: z.string().optional(), primary_exchange: z.string().optional(), currency_name: z.string().optional() }) });

export function parseMassiveCapabilities(value: string | undefined): MassiveCapability[] {
  if (!value?.trim()) return [];
  const supported = new Set<string>(SUPPORTED_CAPABILITIES);
  return [...new Set(value.split(',').map((item) => item.trim()).filter((item): item is MassiveCapability => supported.has(item)))];
}

export function parseMassiveIntervals(value: string | undefined): MassiveInterval[] {
  if (!value?.trim()) return [];
  const supported = new Set<string>(['1d', '1h', '5m', '1m']);
  return [...new Set(value.split(',').map((item) => item.trim()).filter((item): item is MassiveInterval => supported.has(item)))];
}

export function parseMassiveDelay(value: string | undefined): QuoteDelay | undefined {
  return value === 'realtime' || value === 'delayed' || value === 'eod' ? value : undefined;
}

export function createMassiveSourcePlugin(): SourcePlugin<MassiveSourceConfig> {
  const manifest = manifestFor(SUPPORTED_CAPABILITIES, ['1d', '1h', '5m', '1m'], 'delayed', 60, 4);
  return {
    manifest,
    create(config): SourceInstance {
      const capabilities = [...new Set(config.enabledCapabilities)].filter((item) => SUPPORTED_CAPABILITIES.includes(item));
      const intervals = [...new Set(config.historyIntervals)].filter((item) => ['1d', '1h', '5m', '1m'].includes(item));
      return {
        manifest: manifestFor(capabilities, intervals, config.delay, positive(config.requestsPerMinute, 60), positive(config.concurrent, 4)),
        enabled: (config.enabled ?? true) && Boolean(config.apiKey.trim()) && capabilities.length > 0,
        credentialScope: `credential:massive-${createHash('sha256').update(config.apiKey).digest('hex').slice(0, 16)}`,
        ports: { finance: sourceFinancePort(PROVIDER, createMassiveFinanceConnector(config)) },
      };
    },
  };
}

export function createMassiveFinanceConnector(options: MassiveSourceConfig): ProviderFinancePort {
  const apiUrl = options.apiUrl?.replace(/\/+$/, '') || DEFAULT_API_URL;
  return {
    async getQuote(input, ctx = {}) {
      const retrievedAt = new Date().toISOString();
      const parsed = parseFinanceInstrument(input.instrumentId, new Set(['US']));
      if (!parsed.parsed) return quoteFailure(PROVIDER, input.instrumentId, retrievedAt, parsed.code ?? 'INVALID_INSTRUMENT', parsed.message ?? 'Invalid instrument.');
      const path = `/v2/last/trade/${encodeURIComponent(parsed.parsed.symbol)}`;
      const result = await request(apiUrl, path, options, ctx, LastTradeSchema);
      if (!result.ok) return quoteFailure(PROVIDER, input.instrumentId, retrievedAt, result.code, result.message);
      const trade = result.data.results;
      const quote: Quote = { instrument: { instrumentId: parsed.parsed.instrumentId, market: 'US', symbol: parsed.parsed.symbol, currency: 'USD', providerSymbols: { [PROVIDER]: trade.T ?? parsed.parsed.symbol } }, price: trade.p, volume: trade.s, currency: 'USD', timestamp: new Date(trade.t > 1e14 ? trade.t / 1e6 : trade.t).toISOString() };
      return ok(quote, retrievedAt, `${apiUrl}${path}`);
    },
    async getHistory(input, ctx = {}) {
      const retrievedAt = new Date().toISOString();
      const parsed = parseFinanceInstrument(input.instrumentId, new Set(['US']));
      if (!parsed.parsed) return historyFailure(PROVIDER, retrievedAt, parsed.code ?? 'INVALID_INSTRUMENT', parsed.message ?? 'Invalid instrument.');
      const range = intervalRange(input);
      const path = `/v2/aggs/ticker/${encodeURIComponent(parsed.parsed.symbol)}/range/${range.multiplier}/${range.timespan}/${input.from.slice(0, 10)}/${input.to.slice(0, 10)}?adjusted=true&sort=asc&limit=50000`;
      const result = await request(apiUrl, path, options, ctx, AggsSchema);
      if (!result.ok) return historyFailure(PROVIDER, retrievedAt, result.code, result.message);
      const bars: PriceBar[] = (result.data.results ?? []).map((bar) => ({ timestamp: new Date(bar.t).toISOString(), open: bar.o, high: bar.h, low: bar.l, close: bar.c, volume: bar.v }));
      return ok(bars, retrievedAt, `${apiUrl}${path.split('?')[0]}`);
    },
    async getProfile(input, ctx = {}) {
      const retrievedAt = new Date().toISOString();
      const parsed = parseFinanceInstrument(input.instrumentId, new Set(['US']));
      if (!parsed.parsed) return profileFailure(PROVIDER, input.instrumentId, retrievedAt, parsed.code ?? 'INVALID_INSTRUMENT', parsed.message ?? 'Invalid instrument.');
      const path = `/v3/reference/tickers/${encodeURIComponent(parsed.parsed.symbol)}`;
      const result = await request(apiUrl, path, options, ctx, TickerSchema);
      if (!result.ok) return profileFailure(PROVIDER, input.instrumentId, retrievedAt, result.code, result.message);
      const item = result.data.results;
      const profile: CompanyProfile = { instrument: { instrumentId: parsed.parsed.instrumentId, market: 'US', symbol: parsed.parsed.symbol, name: item.name, exchange: item.primary_exchange, currency: 'USD', providerSymbols: { [PROVIDER]: item.ticker } }, description: item.description, industry: item.sic_description, website: item.homepage_url, employees: item.total_employees, marketCap: item.market_cap };
      return ok(profile, retrievedAt, `${apiUrl}${path}`);
    },
  };
}

async function request<T>(apiUrl: string, path: string, options: MassiveSourceConfig, ctx: ConnectorRunContext, schema: z.ZodType<T>): Promise<{ ok: true; data: T } | { ok: false; code: 'AUTH_REQUIRED' | 'RATE_LIMITED' | 'SOURCE_UNAVAILABLE' | 'INVALID_PAYLOAD'; message: string }> {
  try {
    const separator = path.includes('?') ? '&' : '?';
    const response = await withTimeout(ctx, ctx.timeoutMs ?? options.timeoutMs ?? 10_000, (signal) => resolveFetch(ctx, options)(`${apiUrl}${path}${separator}apiKey=${encodeURIComponent(options.apiKey)}`, { headers: { accept: 'application/json' }, signal }));
    if (!response.ok) return { ok: false, code: warningCode(response.status, '') === 'RATE_LIMITED' ? 'RATE_LIMITED' : response.status === 401 || response.status === 403 ? 'AUTH_REQUIRED' : 'SOURCE_UNAVAILABLE', message: `Massive HTTP ${response.status}` };
    const parsed = schema.safeParse(await response.json());
    return parsed.success ? { ok: true, data: parsed.data } : { ok: false, code: 'INVALID_PAYLOAD', message: 'Massive response schema changed.' };
  } catch (error) {
    return { ok: false, code: 'SOURCE_UNAVAILABLE', message: error instanceof Error ? error.message : String(error) };
  }
}

function manifestFor(capabilities: readonly MassiveCapability[], intervals: readonly MassiveInterval[], delay: QuoteDelay, requestsPerMinute: number, concurrent: number): SourceManifest {
  return { id: PROVIDER, name: 'Massive REST', sourceType: 'licensed-vendor', requiresAuth: true, allowRedistribution: false, capabilities: capabilities.map((capability) => ({ capability: capability as Capability, markets: ['US'], securityTypes: ['stock', 'etf'], qualityTier: 'B', authority: 'licensed', ttlMs: capability === 'quote' ? 15_000 : capability === 'history' ? 3_600_000 : 86_400_000, redistribution: 'credential-cache-only', transport: 'vendor-api', ...(capability === 'quote' ? { delay } : {}), ...(capability === 'history' ? { intervals } : {}) })), rateLimit: { maxRequests: requestsPerMinute, windowMs: 60_000, concurrent } };
}
function ok<T>(data: T, retrievedAt: string, url: string): ResearchResult<T> { return { schemaVersion: RESEARCH_SCHEMA_VERSION, data, citations: [{ title: 'Massive market data', url, sourceType: 'PRICE', provider: PROVIDER, retrievedAt, qualityTier: 'B' }], freshness: [{ provider: PROVIDER, asOf: retrievedAt, retrievedAt, stale: false }], warnings: [{ code: 'REDISTRIBUTION_LIMITED', message: 'Massive data remains inside the configured credential cache scope.', provider: PROVIDER }] }; }
function intervalRange(input: HistoryInput): { multiplier: number; timespan: string } { switch (input.interval ?? '1d') { case '1m': return { multiplier: 1, timespan: 'minute' }; case '5m': return { multiplier: 5, timespan: 'minute' }; case '1h': return { multiplier: 1, timespan: 'hour' }; default: return { multiplier: 1, timespan: 'day' }; } }
function positive(value: number | undefined, fallback: number) { return Number.isInteger(value) && value! > 0 ? value! : fallback; }
