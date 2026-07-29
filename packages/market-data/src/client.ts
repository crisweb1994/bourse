import { createCnFilingsConnector } from './connectors/filings/cn';
import { createHkexFilingsConnector } from './connectors/filings/hkex';
import { createSecEdgarFilingsConnector } from './connectors/filings/sec-edgar';
import { createAlphaVantageFinanceConnector } from './connectors/finance/alpha-vantage';
import { createCnFinanceConnector } from './connectors/finance/cn';
import { createEastmoneyHkProfileConnector } from './connectors/finance/eastmoney-hk-profile';
import { createEodhdFinanceConnector } from './connectors/finance/eodhd';
import { createNasdaqFinanceConnector } from './connectors/finance/nasdaq';
import { createSecEdgarProfileConnector } from './connectors/finance/sec-profile';
import { createSinaUsFinanceConnector } from './connectors/finance/sina';
import { createTencentHkFinanceConnector } from './connectors/finance/tencent-hk';
import { createTencentCnFinanceConnector } from './connectors/finance/tencent-cn';
import { createTwelveDataFinanceConnector } from './connectors/finance/twelve-data';
import { createYahooFinanceConnector } from './connectors/finance/yahoo';
import { createEastmoneyFinancialsConnector } from './connectors/financials/eastmoney';
import { createEastmoneyHkFinancialsConnector } from './connectors/financials/eastmoney-hk';
import { createSecEdgarXbrlFinancialsConnector } from './connectors/financials/sec-edgar-xbrl';
import { createOfficialMacroConnector } from './connectors/macro/official';
import { EastMoneyInstrumentSearchProvider } from './connectors/instrument-search/eastmoney';
import { TencentInstrumentSearchProvider } from './connectors/instrument-search/tencent';
import { YahooInstrumentSearchProvider } from './connectors/instrument-search/yahoo';
import type { ConnectorRunContext } from './connectors/types';
import type { ResearchResult, ResearchResultV2 } from './contracts/result';
import type { RoutedResult, SourceResult } from './contracts/source-result';
import type { FilingSummary } from './ports/filings';
import type { CompanyProfile, HistoryInput, PriceBar, Quote } from './ports/finance';
import type { FinancialsBundle } from './ports/financials';
import type { MacroSnapshot } from './ports/macro';
import type { InstrumentSearchResult } from './ports/instrument-search';
import type { MarketSession } from './contracts/calendar';
import type { CachePort } from './ports/cache';
import type { SourceRequestContext } from './ports/request-context';
import { MemoryCache } from './cache/memory-cache';
import { createBuiltInSources, type BuiltInProviderPorts } from './sources/built-in';
import { adaptLegacyResult, unavailable } from './sources/legacy-adapter';
import { InMemorySourceHealth } from './sources/health';
import { InMemoryRateLimiter } from './sources/rate-limit';
import type { SourceInstance } from './sources/plugin';
import { SourceRegistry } from './sources/registry';
import { CapabilityPlanner, type RouteRequest } from './routing/planner';
import { CapabilityRouter } from './routing/router';
import { DEFAULT_ROUTING_POLICIES, RoutingPolicies, type RoutingPolicy } from './routing/policy';
import { parseInstrumentId } from './util/instrument-id';

const DEFAULT_SEC_USER_AGENT = 'stock-suggest-research contact@example.com';
type SupportedMarket = 'US' | 'CN' | 'HK';

/** Deprecated provider bag retained only for API dependency-injection compatibility. */
export interface MarketDataProviders extends BuiltInProviderPorts {}

export interface CreateMarketDataOptions {
  secUserAgent?: string;
  twelveDataApiKey?: string;
  alphaVantageApiKey?: string;
  eodhdApiKey?: string;
  providers?: Partial<MarketDataProviders>;
  cache?: CachePort;
  policies?: readonly RoutingPolicy[];
}

export interface ResearchMarketDataClientOptions {
  cache?: CachePort;
  policies?: readonly RoutingPolicy[];
}

/**
 * v2 public client. It expresses capabilities only; it knows no provider IDs.
 * The compatibility MarketDataClient below converts its nullable results back
 * into the v1 envelope until API and analysis migrate.
 */
export class ResearchMarketDataClient {
  private readonly router: CapabilityRouter;

  constructor(
    private readonly registry: SourceRegistry,
    options: ResearchMarketDataClientOptions = {},
  ) {
    const health = new InMemorySourceHealth();
    this.router = new CapabilityRouter(
      new CapabilityPlanner(registry, health),
      new RoutingPolicies(options.policies ?? DEFAULT_ROUTING_POLICIES),
      health,
      new InMemoryRateLimiter(),
      options.cache ?? new MemoryCache(),
    );
  }

  getQuote(instrumentId: string, ctx: ConnectorRunContext = {}): Promise<ResearchResultV2<Quote>> {
    return this.routeInstrument('quote', instrumentId, ctx, { instrumentId }, async (source, requestContext) => {
      const port = source.ports.finance;
      return port
        ? adaptLegacyResult(source.manifest.id, await port.getQuote({ instrumentId }, connectorContext(requestContext, ctx)), usableQuote)
        : unavailable(source.manifest.id, 'Source does not implement QuotePort.');
    });
  }

  getHistory(input: HistoryInput, ctx: ConnectorRunContext = {}): Promise<ResearchResultV2<PriceBar[]>> {
    return this.routeInstrument('history', input.instrumentId, ctx, input, async (source, requestContext) => {
      const port = source.ports.finance;
      return port
        ? adaptLegacyResult(source.manifest.id, await port.getHistory(input, connectorContext(requestContext, ctx)), usableHistory)
        : unavailable(source.manifest.id, 'Source does not implement HistoryPort.');
    }, input.interval);
  }

  getProfile(instrumentId: string, ctx: ConnectorRunContext = {}): Promise<ResearchResultV2<CompanyProfile>> {
    return this.routeInstrument('profile', instrumentId, ctx, { instrumentId }, async (source, requestContext) => {
      const port = source.ports.profile ?? (source.ports.finance?.getProfile
        ? { getProfile: source.ports.finance.getProfile.bind(source.ports.finance) }
        : undefined);
      return port
        ? adaptLegacyResult(source.manifest.id, await port.getProfile({ instrumentId }, connectorContext(requestContext, ctx)), usableProfile)
        : unavailable(source.manifest.id, 'Source does not implement ProfilePort.');
    });
  }

  getFinancials(instrumentId: string, ctx: ConnectorRunContext = {}): Promise<ResearchResultV2<FinancialsBundle>> {
    return this.routeInstrument('financials', instrumentId, ctx, { instrumentId }, async (source, requestContext) => {
      const port = source.ports.financials;
      return port
        ? adaptLegacyResult(source.manifest.id, await port.fetchFinancials({ instrumentId }, connectorContext(requestContext, ctx)), (data) => data !== null)
        : unavailable(source.manifest.id, 'Source does not implement FinancialsPort.');
    });
  }

  getFilings(instrumentId: string, limit = 10, ctx: ConnectorRunContext = {}): Promise<ResearchResultV2<FilingSummary[]>> {
    return this.routeInstrument('filings', instrumentId, ctx, { instrumentId, limit }, async (source, requestContext) => {
      const port = source.ports.filings;
      if (!port) return unavailable(source.manifest.id, 'Source does not implement FilingsPort.');
      const result = await port.searchFilings({ instrumentId, limit }, connectorContext(requestContext, ctx));
      return adaptLegacyResult(source.manifest.id, result, (data) => data.length > 0);
    });
  }

  getMacro(market: SupportedMarket, ctx: ConnectorRunContext = {}): Promise<ResearchResultV2<MacroSnapshot>> {
    const request = routeRequest('macro', market, { market }, ctx);
    return this.toV2(this.router.fetch(request, async (source, requestContext) => {
      const port = source.ports.macro;
      return port
        ? adaptLegacyResult(source.manifest.id, await port.fetchMacro({ market }, connectorContext(requestContext, ctx)), (data) => data.observations.length > 0)
        : unavailable(source.manifest.id, 'Source does not implement MacroPort.');
    }));
  }

  getMarketSession(market: SupportedMarket, at?: string): Promise<ResearchResultV2<MarketSession>> {
    const request: RouteRequest = { capability: 'market-calendar', market, input: { market, at }, credentialScope: 'public', timeoutMs: 1_000 };
    return this.toV2(this.router.fetch(request, async (source, context) => {
      const port = source.ports.marketCalendar;
      return port
        ? port.getMarketSession({ market, ...(at ? { at } : {}) }, context)
        : unavailable(source.manifest.id, 'Source does not implement MarketCalendarPort.');
    }));
  }

  async searchInstruments(query: string, signal?: AbortSignal): Promise<ResearchResultV2<InstrumentSearchResult[]>> {
    const normalized = query.trim();
    if (!normalized) return this.toV2<InstrumentSearchResult[]>({ status: 'empty', data: null, citations: [], freshness: [], warnings: [], attempts: [] });
    const request: RouteRequest = { capability: 'instrument-search', market: 'US', input: { query: normalized }, credentialScope: 'public', signal, timeoutMs: 5_000 };
    return this.toV2(this.router.fetch(request, async (source) => {
      const port = source.ports.instrumentSearch;
      if (!port) return unavailable(source.manifest.id, 'Source does not implement InstrumentSearchPort.');
      const data = await port.search(normalized, signal);
      return data.length > 0
        ? { status: 'ok', data, sourceId: source.manifest.id, citations: [], freshness: [], warnings: [] }
        : { status: 'empty', data: null, sourceId: source.manifest.id, citations: [], freshness: [], warnings: [] };
    }, { merge: mergeInstrumentSearch }));
  }

  private async routeInstrument<T>(
    capability: RouteRequest['capability'],
    instrumentId: string,
    ctx: ConnectorRunContext,
    input: unknown,
    operation: (source: SourceInstance, context: SourceRequestContext) => Promise<SourceResult<T>>,
    interval?: RouteRequest['interval'],
  ): Promise<ResearchResultV2<T>> {
    const parsed = parseInstrumentId(instrumentId);
    if (!parsed || !isSupportedMarket(parsed.market)) {
      return this.toV2({
        status: 'failed',
        data: null,
        citations: [],
        freshness: [],
        warnings: [{ code: 'INVALID_INSTRUMENT', message: `Unsupported instrumentId: ${instrumentId}` }],
        attempts: [],
        error: { code: 'UNSUPPORTED_REQUEST', message: `Unsupported instrumentId: ${instrumentId}` },
      });
    }
    return this.toV2(this.router.fetch(routeRequest(capability, parsed.market, input, ctx, interval, parsed.raw), operation));
  }

  private toV2<T>(result: Promise<RoutedResult<T>> | RoutedResult<T>): Promise<ResearchResultV2<T>> {
    return Promise.resolve(result).then((value) => {
      const trace = {
        attempts: value.attempts,
        ...((value.status === 'ok' || value.status === 'partial') && value.selectedSource
          ? { selectedSource: value.selectedSource }
          : {}),
      };
      if (value.status === 'ok' || value.status === 'partial') {
        return { schemaVersion: '2.0', status: value.status, data: value.data, citations: value.citations, freshness: value.freshness, warnings: value.warnings, trace };
      }
      return { schemaVersion: '2.0', status: value.status, data: null, citations: value.citations, freshness: value.freshness, warnings: value.warnings, trace, ...(value.error ? { error: value.error } : {}) };
    });
  }
}

/** Compatibility facade. It exposes the v1 API but routes every core capability through v2. */
export class MarketDataClient {
  private readonly research: ResearchMarketDataClient;

  constructor(
    private readonly providers: MarketDataProviders,
    options: ResearchMarketDataClientOptions = {},
  ) {
    this.research = new ResearchMarketDataClient(new SourceRegistry(createBuiltInSources(providers)), options);
  }

  async searchInstruments(query: string, signal?: AbortSignal): Promise<InstrumentSearchResult[]> {
    const result = await this.research.searchInstruments(query, signal);
    return result.data ?? [];
  }

  async getQuote(instrumentId: string, ctx: ConnectorRunContext = {}): Promise<ResearchResult<Quote>> {
    return legacy(await this.research.getQuote(instrumentId, ctx), emptyQuote(instrumentId));
  }

  async getHistory(input: HistoryInput, ctx: ConnectorRunContext = {}): Promise<ResearchResult<PriceBar[]>> {
    return legacy(await this.research.getHistory(input, ctx), []);
  }

  async getProfile(instrumentId: string, ctx: ConnectorRunContext = {}): Promise<ResearchResult<CompanyProfile | null>> {
    return legacy(await this.research.getProfile(instrumentId, ctx), null);
  }

  async getFinancials(instrumentId: string, ctx: ConnectorRunContext = {}): Promise<ResearchResult<FinancialsBundle | null>> {
    return legacy(await this.research.getFinancials(instrumentId, ctx), null);
  }

  async getFilings(instrumentId: string, limit = 10, ctx: ConnectorRunContext = {}): Promise<ResearchResult<FilingSummary[]>> {
    return legacy(await this.research.getFilings(instrumentId, limit, ctx), []);
  }

  async getMacro(market: SupportedMarket, ctx: ConnectorRunContext = {}): Promise<ResearchResult<MacroSnapshot>> {
    return legacy(await this.research.getMacro(market, ctx), { market, observations: [] });
  }

}

export function createMarketData(options: CreateMarketDataOptions = {}): MarketDataClient {
  return new MarketDataClient(createMarketDataProviders(options), options);
}

/** Creates the v2 client from already-constructed source instances. */
export function createResearchMarketDataClient(
  providers: MarketDataProviders,
  options: ResearchMarketDataClientOptions = {},
): ResearchMarketDataClient {
  return new ResearchMarketDataClient(new SourceRegistry(createBuiltInSources(providers)), options);
}

export function createMarketDataProviders(options: CreateMarketDataOptions = {}): MarketDataProviders {
  const secUserAgent = options.secUserAgent?.trim() || DEFAULT_SEC_USER_AGENT;
  const supplied = options.providers ?? {};
  return {
    ...(supplied.twelveData ? { twelveData: supplied.twelveData } : options.twelveDataApiKey?.trim() ? { twelveData: createTwelveDataFinanceConnector({ apiKey: options.twelveDataApiKey.trim() }) } : {}),
    ...(supplied.alphaVantage ? { alphaVantage: supplied.alphaVantage } : options.alphaVantageApiKey?.trim() ? { alphaVantage: createAlphaVantageFinanceConnector({ apiKey: options.alphaVantageApiKey.trim() }) } : {}),
    ...(supplied.eodhd ? { eodhd: supplied.eodhd } : options.eodhdApiKey?.trim() ? { eodhd: createEodhdFinanceConnector({ apiKey: options.eodhdApiKey.trim() }) } : {}),
    yahoo: supplied.yahoo ?? createYahooFinanceConnector(),
    nasdaq: supplied.nasdaq ?? createNasdaqFinanceConnector(),
    sinaUs: supplied.sinaUs ?? createSinaUsFinanceConnector(),
    tencentHk: supplied.tencentHk ?? createTencentHkFinanceConnector(),
    tencentCn: supplied.tencentCn ?? createTencentCnFinanceConnector(),
    cnFinance: supplied.cnFinance ?? createCnFinanceConnector(),
    secProfile: supplied.secProfile ?? createSecEdgarProfileConnector({ userAgent: secUserAgent }),
    hkProfile: supplied.hkProfile ?? createEastmoneyHkProfileConnector(),
    usFinancials: supplied.usFinancials ?? createSecEdgarXbrlFinancialsConnector({ userAgent: secUserAgent }),
    cnFinancials: supplied.cnFinancials ?? createEastmoneyFinancialsConnector(),
    hkFinancials: supplied.hkFinancials ?? createEastmoneyHkFinancialsConnector(),
    usFilings: supplied.usFilings ?? createSecEdgarFilingsConnector({ userAgent: secUserAgent }),
    cnFilings: supplied.cnFilings ?? createCnFilingsConnector(),
    hkFilings: supplied.hkFilings ?? createHkexFilingsConnector(),
    macro: supplied.macro ?? createOfficialMacroConnector(),
    instrumentSearch: supplied.instrumentSearch ?? [new EastMoneyInstrumentSearchProvider(), new TencentInstrumentSearchProvider(), new YahooInstrumentSearchProvider()],
  };
}

function routeRequest(
  capability: RouteRequest['capability'],
  market: SupportedMarket,
  input: unknown,
  ctx: ConnectorRunContext,
  interval?: RouteRequest['interval'],
  instrumentId?: string,
): RouteRequest {
  return { capability, market, input, credentialScope: 'public', ...(ctx.signal ? { signal: ctx.signal } : {}), ...(ctx.timeoutMs ? { timeoutMs: ctx.timeoutMs } : {}), ...(interval ? { interval } : {}), ...(instrumentId ? { instrumentId } : {}) };
}

function connectorContext(context: SourceRequestContext, original: ConnectorRunContext): ConnectorRunContext {
  return {
    ...original,
    signal: context.signal ?? original.signal,
    timeoutMs: context.timeoutMs,
    ...(context.resolvedInstrument ? { resolvedInstrument: context.resolvedInstrument } : {}),
  };
}

function legacy<T>(result: ResearchResultV2<T>, fallback: T): ResearchResult<T> {
  return {
    schemaVersion: '1.0',
    data: result.data ?? fallback,
    citations: result.citations,
    freshness: result.freshness,
    warnings: result.warnings,
    trace: {
      providerCalls: result.trace.attempts.filter((attempt) => attempt.latencyMs !== undefined).map((attempt) => ({
        provider: attempt.sourceId,
        operation: attempt.capability,
        durationMs: attempt.latencyMs ?? 0,
        status: attempt.outcome === 'hit' ? 'OK' : attempt.reasonCode === 'RATE_LIMITED' ? 'RATE_LIMITED' : attempt.reasonCode === 'TIMEOUT' ? 'TIMEOUT' : 'ERROR',
      })),
    },
  };
}

function usableQuote(quote: Quote): boolean {
  return Number.isFinite(quote.price) && quote.price > 0;
}

function usableHistory(history: PriceBar[]): boolean {
  return history.filter((bar) => Number.isFinite(bar.close) && bar.close > 0 && !Number.isNaN(Date.parse(bar.timestamp))).length >= 20;
}

function usableProfile(profile: CompanyProfile): boolean {
  return Boolean(profile.description || profile.sector || profile.industry || profile.website || typeof profile.employees === 'number');
}

function mergeInstrumentSearch(results: readonly SourceResult<InstrumentSearchResult[]>[]): InstrumentSearchResult[] | null {
  const seen = new Set<string>();
  const merged = results.flatMap((result) => result.status === 'ok' ? result.data : []).filter((item) => {
    const key = `${item.market}:${item.symbol}:${item.exchange}`.toUpperCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return merged.length > 0 ? merged : null;
}

function emptyQuote(instrumentId: string): Quote {
  const parsed = parseInstrumentId(instrumentId);
  return {
    instrument: { instrumentId: parsed?.raw ?? instrumentId, market: parsed?.market ?? 'US', symbol: parsed?.symbol ?? instrumentId.split(':').at(-1) ?? instrumentId },
    price: Number.NaN,
    currency: parsed?.market === 'HK' ? 'HKD' : parsed?.market === 'CN' ? 'CNY' : 'USD',
    timestamp: new Date(0).toISOString(),
  };
}

function isSupportedMarket(market: string | undefined): market is SupportedMarket {
  return market === 'US' || market === 'CN' || market === 'HK';
}
