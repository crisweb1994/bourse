import { createHash } from 'node:crypto';
import { z } from 'zod';
import { RESEARCH_SCHEMA_VERSION, type ResearchResult } from '../../contracts/result';
import type { ResearchWarning } from '../../contracts/warning';
import type { CapabilitySpec, DataSet, SourceManifest } from '../../contracts/source';
import type { MarketSession } from '../../contracts/calendar';
import type { ProviderCorporateActionsPort, CorporateAction, CorporateActionDataSet } from '../../ports/corporate-actions';
import type { ProviderMarketEventsPort, MarketEvent, MarketEventDataSet } from '../../ports/market-events';
import type { ProviderOwnershipPort, OwnershipDataSet, OwnershipObservation } from '../../ports/ownership';
import type { MarketCalendarPort } from '../../ports/market-calendar';
import type { ConnectorRunContext, FetchLike } from '../types';
import { resolveFetch, withTimeout } from '../http';
import { parseInstrumentId } from '../../util/instrument-id';
import { sourceCorporateActionsPort, sourceMarketEventsPort, sourceOwnershipPort } from '../../sources/provider-port';
import type { SourceInstance, SourcePlugin } from '../../sources/plugin';

const PROVIDER = 'tushare-pro';
const DEFAULT_API_URL = 'https://api.tushare.pro';
const DEFAULT_TIMEOUT_MS = 10_000;

export const TUSHARE_SUPPORTED_DATASETS = [
  'session',
  'adjustment-factor',
  'dividend',
  'buyback',
  'shareholder-count',
  'stock-connect',
  'margin',
  'earnings-guidance',
  'unlock',
  'lhb',
  'suspension',
  'price-limit',
] as const satisfies readonly DataSet[];
export type TushareDataSet = (typeof TUSHARE_SUPPORTED_DATASETS)[number];

export function parseTushareDataSets(value: string | undefined): TushareDataSet[] {
  if (!value?.trim()) return [];
  const supported = new Set<string>(TUSHARE_SUPPORTED_DATASETS);
  return [...new Set(value.split(',').map((item) => item.trim()).filter((item): item is TushareDataSet => supported.has(item)))];
}

export interface TushareSourceConfig {
  enabled?: boolean;
  token: string;
  enabledDataSets: readonly TushareDataSet[];
  apiUrl?: string;
  requestsPerMinute?: number;
  concurrent?: number;
  timeoutMs?: number;
  fetchLike?: FetchLike;
}

interface TushareClient {
  query(apiName: string, params: Record<string, unknown>, fields: readonly string[], ctx: ConnectorRunContext): Promise<TushareQueryResult>;
}

type TushareQueryResult =
  | { ok: true; rows: Array<Record<string, unknown>>; retrievedAt: string }
  | { ok: false; warning: ResearchWarning; retrievedAt: string };

const TushareEnvelopeSchema = z.object({
  code: z.number(),
  msg: z.string().nullish(),
  data: z.object({
    fields: z.array(z.string()),
    items: z.array(z.array(z.unknown())),
  }).nullish(),
});

export function createTushareSourcePlugin(): SourcePlugin<TushareSourceConfig> {
  const manifest = manifestFor(TUSHARE_SUPPORTED_DATASETS, 60, 2);
  return {
    manifest,
    create(config): SourceInstance {
      const token = config.token.trim();
      const enabledDataSets = uniqueSupported(config.enabledDataSets);
      const effectiveManifest = manifestFor(
        enabledDataSets,
        positiveInt(config.requestsPerMinute, 60),
        positiveInt(config.concurrent, 2),
      );
      const client = createTushareClient({
        token,
        apiUrl: config.apiUrl,
        timeoutMs: config.timeoutMs,
        fetchLike: config.fetchLike,
      });
      const corporateActions = createTushareCorporateActionsPort(client);
      const ownership = createTushareOwnershipPort(client);
      const marketEvents = createTushareMarketEventsPort(client);
      const enabled = (config.enabled ?? true) && token.length > 0 && enabledDataSets.length > 0;
      return {
        manifest: effectiveManifest,
        enabled,
        credentialScope: `credential:tushare-${credentialFingerprint(token)}`,
        ports: {
          ...(hasAny(enabledDataSets, ['adjustment-factor', 'dividend', 'buyback'])
            ? { corporateActions: sourceCorporateActionsPort(PROVIDER, corporateActions) }
            : {}),
          ...(hasAny(enabledDataSets, ['shareholder-count', 'stock-connect', 'margin'])
            ? { ownership: sourceOwnershipPort(PROVIDER, ownership) }
            : {}),
          ...(hasAny(enabledDataSets, ['earnings-guidance', 'unlock', 'lhb', 'suspension', 'price-limit'])
            ? { marketEvents: sourceMarketEventsPort(PROVIDER, marketEvents) }
            : {}),
          ...(enabledDataSets.includes('session') ? { marketCalendar: createTushareCalendarPort(client) } : {}),
        },
      };
    },
  };
}

export function createTushareClient(options: Pick<TushareSourceConfig, 'token' | 'apiUrl' | 'timeoutMs' | 'fetchLike'>): TushareClient {
  const apiUrl = options.apiUrl?.trim() || DEFAULT_API_URL;
  return {
    async query(apiName, params, fields, ctx) {
      const retrievedAt = new Date().toISOString();
      try {
        const response = await withTimeout(ctx, ctx.timeoutMs ?? options.timeoutMs ?? DEFAULT_TIMEOUT_MS, (signal) =>
          resolveFetch(ctx, options)(apiUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({ api_name: apiName, token: options.token, params, fields: fields.join(',') }),
            signal,
          }),
        );
        if (!response.ok) {
          return { ok: false, retrievedAt, warning: warning(response.status === 429 ? 'RATE_LIMITED' : response.status === 401 || response.status === 403 ? 'AUTH_REQUIRED' : 'SOURCE_UNAVAILABLE', `Tushare HTTP ${response.status}`) };
        }
        const parsed = TushareEnvelopeSchema.safeParse(await response.json());
        if (!parsed.success) return { ok: false, retrievedAt, warning: warning('INVALID_PAYLOAD', 'Tushare response schema changed.') };
        if (parsed.data.code !== 0) {
          const message = parsed.data.msg?.trim() || `Tushare error ${parsed.data.code}`;
          return { ok: false, retrievedAt, warning: warning(classifyTushareError(message), message) };
        }
        if (!parsed.data.data) return { ok: false, retrievedAt, warning: warning('INVALID_PAYLOAD', 'Tushare response omitted data.') };
        const responseFields = parsed.data.data.fields;
        const rows = parsed.data.data.items.map((item) => Object.fromEntries(responseFields.map((field, index) => [field, item[index]])));
        return { ok: true, rows, retrievedAt };
      } catch (error) {
        return { ok: false, retrievedAt, warning: warning('SOURCE_UNAVAILABLE', error instanceof Error ? error.message : String(error)) };
      }
    },
  };
}

function createTushareCorporateActionsPort(client: TushareClient): ProviderCorporateActionsPort {
  return {
    async listActions(input, ctx = {}) {
      const definition = CORPORATE_ACTION_QUERIES[input.dataSet];
      if (!definition) return failed([], 'PERMISSION_DENIED', `Tushare dataset ${input.dataSet} is not implemented.`);
      const symbol = tushareSymbol(input.instrumentId);
      if (!symbol) return failed([], 'INVALID_INSTRUMENT', 'Tushare only supports canonical CN stock instruments.');
      const result = await client.query(definition.api, { ts_code: symbol, ...dateParams(input) }, definition.fields, ctx);
      if (!result.ok) return failureResult([], result);
      const rows = result.rows.flatMap((row) => definition.map(row, input.instrumentId));
      return success(rows, result.retrievedAt, definition.api);
    },
  };
}

function createTushareOwnershipPort(client: TushareClient): ProviderOwnershipPort {
  return {
    async listOwnership(input, ctx = {}) {
      const definition = OWNERSHIP_QUERIES[input.dataSet];
      if (!definition) return failed([], 'PERMISSION_DENIED', `Tushare dataset ${input.dataSet} is not implemented.`);
      const symbol = tushareSymbol(input.instrumentId);
      if (!symbol) return failed([], 'INVALID_INSTRUMENT', 'Tushare only supports canonical CN stock instruments.');
      const result = await client.query(definition.api, { ts_code: symbol, ...dateParams(input) }, definition.fields, ctx);
      if (!result.ok) return failureResult([], result);
      return success(result.rows.flatMap((row) => definition.map(row, input.instrumentId)), result.retrievedAt, definition.api);
    },
  };
}

function createTushareMarketEventsPort(client: TushareClient): ProviderMarketEventsPort {
  return {
    async listEvents(input, ctx = {}) {
      const definition = MARKET_EVENT_QUERIES[input.dataSet];
      if (!definition) return failed([], 'PERMISSION_DENIED', `Tushare dataset ${input.dataSet} is not implemented.`);
      const symbol = tushareSymbol(input.instrumentId);
      if (!symbol) return failed([], 'INVALID_INSTRUMENT', 'Tushare only supports canonical CN stock instruments.');
      const result = await client.query(definition.api, { ts_code: symbol, ...dateParams(input) }, definition.fields, ctx);
      if (!result.ok) return failureResult([], result);
      return success(result.rows.flatMap((row) => definition.map(row, input.instrumentId)), result.retrievedAt, definition.api);
    },
  };
}

function createTushareCalendarPort(client: TushareClient): MarketCalendarPort {
  return {
    async getMarketSession(input, ctx) {
      const at = new Date(input.at ?? Date.now());
      const date = compactDate(at.toISOString());
      const result = await client.query('trade_cal', { exchange: 'SSE', start_date: date, end_date: date }, ['exchange', 'cal_date', 'is_open', 'pretrade_date'], ctx);
      if (!result.ok) return sourceFailureResult<MarketSession>(result);
      const row = result.rows[0];
      const open = String(row?.is_open ?? '') === '1';
      const data: MarketSession = {
        market: input.market,
        asOf: at.toISOString(),
        state: open ? 'OPEN' : 'HOLIDAY',
        timezone: 'Asia/Shanghai',
        tradingDay: isoDate(row?.cal_date) ?? at.toISOString().slice(0, 10),
      };
      return { status: 'ok', data, sourceId: PROVIDER, citations: citation(result.retrievedAt, 'trade_cal'), freshness: freshness(result.retrievedAt), warnings: [] };
    },
  };
}

type QueryDefinition<TDataSet extends string, T> = Partial<Record<TDataSet, {
  api: string;
  fields: readonly string[];
  map(row: Record<string, unknown>, instrumentId: string): T[];
}>>;

const CORPORATE_ACTION_QUERIES: QueryDefinition<CorporateActionDataSet, CorporateAction> = {
  'adjustment-factor': { api: 'adj_factor', fields: ['ts_code', 'trade_date', 'adj_factor'], map: (r, id) => [{ id: stableId('adj', r), instrumentId: id, type: 'ADJUSTMENT_FACTOR', status: 'COMPLETED', effectiveDate: isoDate(r.trade_date), ratioNumerator: decimal(r.adj_factor), ratioDenominator: '1' }] },
  dividend: { api: 'dividend', fields: ['ts_code', 'ann_date', 'div_proc', 'stk_div', 'cash_div_tax', 'record_date', 'ex_date', 'pay_date'], map: (r, id) => [{ id: stableId('dividend', r), instrumentId: id, type: 'DIVIDEND', status: tushareStatus(r.div_proc), announcedAt: isoDate(r.ann_date), recordDate: isoDate(r.record_date), exDate: isoDate(r.ex_date), paymentDate: isoDate(r.pay_date), cashAmount: optionalDecimal(r.cash_div_tax), currency: 'CNY', ratioNumerator: optionalDecimal(r.stk_div), ratioDenominator: optionalDecimal(r.stk_div) ? '10' : undefined }] },
  buyback: { api: 'repurchase', fields: ['ts_code', 'ann_date', 'end_date', 'proc', 'vol', 'amount', 'high_limit', 'low_limit'], map: (r, id) => [{ id: stableId('buyback', r), instrumentId: id, type: 'BUYBACK', status: tushareStatus(r.proc), announcedAt: isoDate(r.ann_date), effectiveDate: isoDate(r.end_date), ratioNumerator: optionalDecimal(r.vol), cashAmount: optionalDecimal(r.amount), currency: 'CNY', price: optionalDecimal(r.high_limit ?? r.low_limit) }] },
};

const OWNERSHIP_QUERIES: QueryDefinition<OwnershipDataSet, OwnershipObservation> = {
  'shareholder-count': { api: 'stk_holdernumber', fields: ['ts_code', 'ann_date', 'end_date', 'holder_num'], map: (r, id) => [{ id: stableId('holders', r), instrumentId: id, kind: 'SHAREHOLDER_COUNT', asOf: isoDate(r.end_date ?? r.ann_date) ?? new Date(0).toISOString(), holderCount: Math.max(0, Math.trunc(numberValue(r.holder_num))) }] },
  'stock-connect': { api: 'hk_hold', fields: ['trade_date', 'ts_code', 'vol', 'ratio', 'exchange'], map: (r, id) => [{ id: stableId('connect', r), instrumentId: id, kind: 'STOCK_CONNECT_HOLDING', asOf: isoDate(r.trade_date) ?? new Date(0).toISOString(), holdingShares: decimal(r.vol), holdingPercentOfFloat: optionalDecimal(r.ratio), exchange: stringValue(r.exchange), sourceDocumentId: `${r.ts_code ?? id}:${r.trade_date ?? ''}` }] },
  margin: { api: 'margin_detail', fields: ['trade_date', 'ts_code', 'rzye', 'rqye', 'rzmre', 'rqyl'], map: (r, id) => [{ id: stableId('margin', r), instrumentId: id, kind: 'MARGIN', asOf: isoDate(r.trade_date) ?? new Date(0).toISOString(), direction: 'NET', value: decimal(numberValue(r.rzye) - numberValue(r.rqye)), unit: 'currency', currency: 'CNY' }] },
};

const MARKET_EVENT_QUERIES: QueryDefinition<MarketEventDataSet, MarketEvent> = {
  'earnings-guidance': { api: 'forecast', fields: ['ts_code', 'ann_date', 'end_date', 'type', 'p_change_min', 'p_change_max', 'summary'], map: (r, id) => [{ id: stableId('forecast', r), instrumentId: id, type: 'EARNINGS_GUIDANCE', occurredAt: isoDate(r.ann_date) ?? new Date(0).toISOString(), effectiveAt: isoDate(r.end_date), title: stringValue(r.summary) ?? stringValue(r.type) ?? 'Earnings guidance', attributes: { guidanceType: stringValue(r.type) ?? '', minChangePercent: numberValue(r.p_change_min), maxChangePercent: numberValue(r.p_change_max) } }] },
  unlock: { api: 'share_float', fields: ['ts_code', 'ann_date', 'float_date', 'float_share', 'float_ratio', 'holder_name', 'share_type'], map: (r, id) => [{ id: stableId('unlock', r), instrumentId: id, type: 'UNLOCK', occurredAt: isoDate(r.ann_date ?? r.float_date) ?? new Date(0).toISOString(), effectiveAt: isoDate(r.float_date), title: `Share unlock${stringValue(r.holder_name) ? `: ${stringValue(r.holder_name)}` : ''}`, shares: decimal(r.float_share), unlockType: stringValue(r.share_type) ?? 'UNKNOWN' }] },
  lhb: { api: 'top_list', fields: ['trade_date', 'ts_code', 'name', 'reason', 'amount', 'l_buy', 'l_sell', 'net_amount'], map: (r, id) => [{ id: stableId('lhb', r), instrumentId: id, type: 'LHB', occurredAt: isoDate(r.trade_date) ?? new Date(0).toISOString(), title: stringValue(r.name) ?? 'Dragon Tiger List', reason: stringValue(r.reason) ?? 'Listed by exchange', topBuySeatNames: [], topSellSeatNames: [], buyAmount: optionalDecimal(r.l_buy), sellAmount: optionalDecimal(r.l_sell), netAmount: optionalDecimal(r.net_amount) }] },
  suspension: { api: 'suspend_d', fields: ['ts_code', 'trade_date', 'suspend_timing', 'suspend_type'], map: (r, id) => [{ id: stableId('suspend', r), instrumentId: id, type: /复牌|resume/i.test(String(r.suspend_type ?? '')) ? 'RESUMPTION' : 'SUSPENSION', occurredAt: isoDate(r.trade_date) ?? new Date(0).toISOString(), title: stringValue(r.suspend_type) ?? 'Trading suspension', attributes: { timing: stringValue(r.suspend_timing) ?? '' } }] },
  'price-limit': { api: 'stk_limit', fields: ['trade_date', 'ts_code', 'pre_close', 'up_limit', 'down_limit'], map: (r, id) => [{ id: stableId('limit', r), instrumentId: id, type: 'PRICE_LIMIT', occurredAt: isoDate(r.trade_date) ?? new Date(0).toISOString(), title: 'Daily price limits', attributes: { previousClose: decimal(r.pre_close), upperLimit: decimal(r.up_limit), lowerLimit: decimal(r.down_limit) } }] },
};

function manifestFor(dataSets: readonly TushareDataSet[], requestsPerMinute: number, concurrent: number): SourceManifest {
  const specs: CapabilitySpec[] = [];
  const add = (capability: 'corporate-actions' | 'ownership' | 'market-events' | 'market-calendar', selected: readonly DataSet[]) => {
    const supported = dataSets.filter((item) => selected.includes(item));
    if (supported.length === 0) return;
    specs.push({ capability, dataSets: supported, markets: ['CN'], securityTypes: capability === 'market-calendar' ? undefined : ['stock'], qualityTier: 'B', authority: 'licensed', ttlMs: capability === 'market-calendar' ? 86_400_000 : 3_600_000, redistribution: 'credential-cache-only', transport: 'vendor-api' });
  };
  add('market-calendar', ['session']);
  add('corporate-actions', ['adjustment-factor', 'dividend', 'buyback']);
  add('ownership', ['shareholder-count', 'stock-connect', 'margin']);
  add('market-events', ['earnings-guidance', 'unlock', 'lhb', 'suspension', 'price-limit']);
  return { id: PROVIDER, name: 'Tushare Pro', sourceType: 'licensed-vendor', requiresAuth: true, allowRedistribution: false, capabilities: specs, rateLimit: { maxRequests: requestsPerMinute, windowMs: 60_000, concurrent } };
}

function success<T>(data: T, retrievedAt: string, api: string): ResearchResult<T> {
  return { schemaVersion: RESEARCH_SCHEMA_VERSION, data, citations: citation(retrievedAt, api), freshness: freshness(retrievedAt), warnings: [{ code: 'REDISTRIBUTION_LIMITED', message: 'Tushare data remains inside the configured credential cache scope.', provider: PROVIDER }] };
}
function failed<T>(data: T, code: ResearchWarning['code'], message: string): ResearchResult<T> { const at = new Date().toISOString(); return { schemaVersion: RESEARCH_SCHEMA_VERSION, data, citations: [], freshness: freshness(at, true), warnings: [warning(code, message)] }; }
function failureResult<T>(data: T, result: Extract<TushareQueryResult, { ok: false }>): ResearchResult<T> { return { schemaVersion: RESEARCH_SCHEMA_VERSION, data, citations: [], freshness: freshness(result.retrievedAt, true), warnings: [result.warning] }; }
function sourceFailureResult<T>(result: Extract<TushareQueryResult, { ok: false }>) { return { status: 'failed' as const, data: null, sourceId: PROVIDER, citations: [], freshness: freshness(result.retrievedAt, true), warnings: [result.warning], error: { code: result.warning.code === 'PERMISSION_DENIED' ? 'PERMISSION_DENIED' as const : result.warning.code === 'RATE_LIMITED' ? 'RATE_LIMITED' as const : result.warning.code === 'INVALID_PAYLOAD' ? 'INVALID_PAYLOAD' as const : 'SOURCE_UNAVAILABLE' as const, message: result.warning.message } }; }
function citation(at: string, api: string) { return [{ title: `Tushare Pro ${api}`, url: 'https://tushare.pro/document/2', sourceType: 'OTHER' as const, provider: PROVIDER, retrievedAt: at, qualityTier: 'B' as const }]; }
function freshness(at: string, stale = false) { return [{ provider: PROVIDER, asOf: at, retrievedAt: at, stale }]; }
function warning(code: ResearchWarning['code'], message: string): ResearchWarning { return { code, message, provider: PROVIDER }; }
function classifyTushareError(message: string): ResearchWarning['code'] { if (/权限|积分|permission|privilege/i.test(message)) return 'PERMISSION_DENIED'; if (/token|登录|认证/i.test(message)) return 'AUTH_REQUIRED'; if (/频率|每分钟|rate|limit/i.test(message)) return 'RATE_LIMITED'; return 'SOURCE_UNAVAILABLE'; }
function uniqueSupported(values: readonly TushareDataSet[]): TushareDataSet[] { const supported = new Set<string>(TUSHARE_SUPPORTED_DATASETS); return [...new Set(values)].filter((value) => supported.has(value)); }
function hasAny(values: readonly TushareDataSet[], expected: readonly TushareDataSet[]) { return values.some((value) => expected.includes(value)); }
function positiveInt(value: number | undefined, fallback: number) { return Number.isInteger(value) && value! > 0 ? value! : fallback; }
function credentialFingerprint(token: string) { return createHash('sha256').update(token).digest('hex').slice(0, 16); }
function tushareSymbol(instrumentId: string): string | null { const parsed = parseInstrumentId(instrumentId); if (!parsed || parsed.market !== 'CN' || !/^\d{6}(?:\.(?:SH|SZ|BJ))?$/i.test(parsed.symbol)) return null; if (/\.(SH|SZ|BJ)$/i.test(parsed.symbol)) return parsed.symbol.toUpperCase(); return `${parsed.symbol}.${parsed.symbol.startsWith('6') ? 'SH' : parsed.symbol.startsWith('8') || parsed.symbol.startsWith('4') || parsed.symbol.startsWith('92') ? 'BJ' : 'SZ'}`; }
function compactDate(value: string) { return value.slice(0, 10).replace(/-/g, ''); }
function isoDate(value: unknown): string | undefined { const raw = stringValue(value); if (!raw) return undefined; const match = raw.match(/^(\d{4})[-/]?(\d{2})[-/]?(\d{2})$/); return match ? `${match[1]}-${match[2]}-${match[3]}` : undefined; }
function decimal(value: unknown): string { const number = numberValue(value); return Number.isFinite(number) ? String(number) : '0'; }
function optionalDecimal(value: unknown): string | undefined { return value === null || value === undefined || value === '' ? undefined : decimal(value); }
function numberValue(value: unknown): number { const number = Number(value); return Number.isFinite(number) ? number : 0; }
function stringValue(value: unknown): string | undefined { const text = typeof value === 'string' ? value.trim() : ''; return text && text !== '-' ? text : undefined; }
function dateParams(input: { from?: string; to?: string }) { return { ...(input.from ? { start_date: compactDate(input.from) } : {}), ...(input.to ? { end_date: compactDate(input.to) } : {}) }; }
function stableId(prefix: string, row: Record<string, unknown>) { return `${PROVIDER}:${prefix}:${createHash('sha1').update(JSON.stringify(row)).digest('hex').slice(0, 16)}`; }
function tushareStatus(value: unknown): CorporateAction['status'] { const text = String(value ?? ''); if (/实施|完成|completed/i.test(text)) return 'COMPLETED'; if (/取消|终止|cancel/i.test(text)) return 'CANCELLED'; if (/预案|announc/i.test(text)) return 'ANNOUNCED'; return 'CONFIRMED'; }
