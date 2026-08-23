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
import { createHkexDerivedFinancialsConnector } from './connectors/financials/hkex-derived';
import { createSecEdgarXbrlFinancialsConnector } from './connectors/financials/sec-edgar-xbrl';
import { createOfficialMacroConnector } from './connectors/macro/official';
import { createNbsMacroSourcePlugin } from './connectors/macro/nbs';
import { createOfficialMacroFileSourcePlugin, type OfficialMacroFileSourceConfig } from './connectors/macro/official-file';
import { createTushareSourcePlugin, type TushareSourceConfig } from './connectors/tushare';
import { createHkexDerivedCorporateActionsConnector, createHkexDerivedMarketEventsConnector, createSfcShortPositionConnector } from './connectors/hk';
import { createMassiveSourcePlugin, type MassiveSourceConfig } from './connectors/massive';
import { createEastmoneyEquityScreenerConnector } from './connectors/equity-screener';
import {
  createCnPublicMarketEventsConnector,
  createCnPublicOwnershipConnector,
} from './connectors/cn-tools/canonical';
import { EastMoneyInstrumentSearchProvider } from './connectors/instrument-search/eastmoney';
import { TencentInstrumentSearchProvider } from './connectors/instrument-search/tencent';
import { YahooInstrumentSearchProvider } from './connectors/instrument-search/yahoo';
import type { ConnectorRunContext } from './connectors/types';
import type { ResearchResult, ResearchResultV2 } from './contracts/result';
import type { RoutedResult, SourceResult } from './contracts/source-result';
import type {
  FilingDocument,
  FilingGetInput,
  FilingSearchInput,
  FilingSummary,
} from './ports/filings';
import type {
  CompanyProfile,
  EarningsConsensusBundle,
  HistoryInput,
  PriceBar,
  Quote,
  QuoteInput,
} from './ports/finance';
import type { FinancialsBundle, FinancialsInput } from './ports/financials';
import type { MacroInput, MacroSnapshot } from './ports/macro';
import type { InstrumentSearchResult } from './ports/instrument-search';
import { rankInstrumentSearchResults } from './util/instrument-search-rank';
import type { MarketSession } from './contracts/calendar';
import type { MarketCode } from './contracts/instrument';
import type { CachePort } from './ports/cache';
import type { SourceRequestContext } from './ports/request-context';
import { MemoryCache } from './cache/memory-cache';
import { createBuiltInSourcePlugins } from './sources/built-in';
import { unavailable } from './sources/provider-port';
import { InMemorySourceHealth } from './sources/health';
import { InMemoryRateLimiter } from './sources/rate-limit';
import type { SourceInstance } from './sources/plugin';
import { SourceRegistry } from './sources/registry';
import { CapabilityPlanner, type RouteConstraints, type RouteRequest } from './routing/planner';
import { CapabilityRouter } from './routing/router';
import { DEFAULT_ROUTING_POLICIES, RoutingPolicies, type RoutingPolicy } from './routing/policy';
import { parseInstrumentId } from './util/instrument-id';
import type { MarketDataEventSink } from './observability/events';
import type { InstrumentResolver } from './sources/resolver';
import type { CorporateAction, CorporateActionsInput } from './ports/corporate-actions';
import type { OwnershipInput, OwnershipObservation } from './ports/ownership';
import type { MarketEvent, MarketEventsInput } from './ports/market-events';
import type {
  EquityScreenerDescriptor,
  EquityScreenerPort,
} from './ports/equity-screener';
import type {
  EquityScreenerSnapshot,
  Market,
  ScreeningQuery,
} from '@bourse/shared-types';

const DEFAULT_SEC_USER_AGENT = 'stock-suggest-research contact@example.com';
type SupportedMarket = 'US' | 'CN' | 'HK';

export interface CreateMarketDataOptions {
  secUserAgent?: string;
  twelveDataApiKey?: string;
  alphaVantageApiKey?: string;
  eodhdApiKey?: string;
  tushare?: TushareSourceConfig;
  massive?: MassiveSourceConfig;
  officialMacroFiles?: readonly OfficialMacroFileSourceConfig[];
  sfcShortPositionCsvUrl?: string;
  cache?: CachePort;
  policies?: readonly RoutingPolicy[];
}

export interface ResearchMarketDataClientOptions {
  cache?: CachePort;
  policies?: readonly RoutingPolicy[];
  eventSink?: MarketDataEventSink;
  resolver?: InstrumentResolver;
  health?: InMemorySourceHealth;
  rateLimiter?: InMemoryRateLimiter;
}

/** v2 public client. It expresses capabilities only; it knows no provider IDs. */
export class ResearchMarketDataClient {
  private readonly router: CapabilityRouter;

  constructor(
    private readonly registry: SourceRegistry,
    options: ResearchMarketDataClientOptions = {},
  ) {
    const health = options.health ?? new InMemorySourceHealth();
    this.router = new CapabilityRouter(
      new CapabilityPlanner(registry, health),
      new RoutingPolicies(options.policies ?? DEFAULT_ROUTING_POLICIES),
      health,
      options.rateLimiter ?? new InMemoryRateLimiter(),
      options.cache ?? new MemoryCache(),
      {
        ...(options.eventSink ? { eventSink: options.eventSink } : {}),
        ...(options.resolver ? { resolver: options.resolver } : {}),
      },
    );
  }

  getQuote(instrumentId: string, ctx: ConnectorRunContext = {}, constraints?: RouteConstraints): Promise<ResearchResultV2<Quote>> {
    return this.routeInstrument('quote', instrumentId, ctx, { instrumentId }, async (source, requestContext) => {
      const port = source.ports.finance;
      return port
        ? port.getQuote({ instrumentId }, connectorContext(requestContext, ctx))
        : unavailable(source.manifest.id, 'Source does not implement QuotePort.');
    }, undefined, undefined, constraints);
  }

  /** Results always have the same length and order as the input. */
  getQuotes(inputs: readonly QuoteInput[], ctx: ConnectorRunContext = {}): Promise<ResearchResultV2<Quote>[]> {
    return Promise.all(inputs.map((input) => this.getQuote(input.instrumentId, ctx)));
  }

  getHistory(input: HistoryInput, ctx: ConnectorRunContext = {}, constraints?: RouteConstraints): Promise<ResearchResultV2<PriceBar[]>> {
    return this.routeInstrument('history', input.instrumentId, ctx, input, async (source, requestContext) => {
      const port = source.ports.finance;
      return port
        ? port.getHistory(input, connectorContext(requestContext, ctx))
        : unavailable(source.manifest.id, 'Source does not implement HistoryPort.');
    }, input.interval, undefined, constraints);
  }

  getProfile(instrumentId: string, ctx: ConnectorRunContext = {}, constraints?: RouteConstraints): Promise<ResearchResultV2<CompanyProfile>> {
    return this.routeInstrument('profile', instrumentId, ctx, { instrumentId }, async (source, requestContext) => {
      const port = source.ports.profile ?? (source.ports.finance?.getProfile
        ? { getProfile: source.ports.finance.getProfile.bind(source.ports.finance) }
        : undefined);
      return port
        ? port.getProfile({ instrumentId }, connectorContext(requestContext, ctx))
        : unavailable(source.manifest.id, 'Source does not implement ProfilePort.');
    }, undefined, undefined, constraints);
  }

  getFinancials(input: string | FinancialsInput, ctx: ConnectorRunContext = {}, constraints?: RouteConstraints): Promise<ResearchResultV2<FinancialsBundle>> {
    const request = typeof input === 'string' ? { instrumentId: input } : input;
    return this.routeInstrument('financials', request.instrumentId, ctx, request, async (source, requestContext) => {
      const port = source.ports.financials;
      return port
        ? port.fetchFinancials(request, connectorContext(requestContext, ctx))
        : unavailable(source.manifest.id, 'Source does not implement FinancialsPort.');
    }, undefined, undefined, constraints);
  }

  listFilings(input: FilingSearchInput, ctx: ConnectorRunContext = {}, constraints?: RouteConstraints): Promise<ResearchResultV2<FilingSummary[]>> {
    return this.routeInstrument('filings', input.instrumentId, ctx, input, async (source, requestContext) => {
      const port = source.ports.filings;
      if (!port) return unavailable(source.manifest.id, 'Source does not implement FilingsPort.');
      return port.searchFilings(input, connectorContext(requestContext, ctx));
    }, undefined, undefined, constraints);
  }

  getFilingDocument(input: FilingGetInput, ctx: ConnectorRunContext = {}, constraints?: RouteConstraints): Promise<ResearchResultV2<FilingDocument>> {
    if (!input.instrumentId) {
      return this.toV2({
        status: 'failed',
        data: null,
        citations: [],
        freshness: [],
        warnings: [{ code: 'INVALID_INSTRUMENT', message: 'Filing document requests require instrumentId.' }],
        attempts: [],
        error: { code: 'UNSUPPORTED_REQUEST', message: 'Filing document requests require instrumentId.' },
      });
    }
    return this.routeInstrument('filing-document', input.instrumentId, ctx, input, async (source, requestContext) => {
      const getFiling = source.ports.filings?.getFiling;
      if (!getFiling) return unavailable(source.manifest.id, 'Source does not implement FilingDocumentPort.');
      return getFiling(input, connectorContext(requestContext, ctx));
    }, undefined, undefined, constraints);
  }

  getEarningsConsensus(instrumentId: string, ctx: ConnectorRunContext = {}, constraints?: RouteConstraints): Promise<ResearchResultV2<EarningsConsensusBundle>> {
    return this.routeInstrument('earnings-consensus', instrumentId, ctx, { instrumentId }, async (source, requestContext) => {
      const operation = source.ports.finance?.fetchEarningsConsensus;
      if (!operation) return unavailable(source.manifest.id, 'Source does not implement earnings consensus.');
      return operation({ instrumentId }, connectorContext(requestContext, ctx));
    }, undefined, undefined, constraints);
  }

  async getMacro(input: SupportedMarket | MacroInput, ctx: ConnectorRunContext = {}, constraints?: RouteConstraints): Promise<ResearchResultV2<MacroSnapshot>> {
    const requestInput: MacroInput = typeof input === 'string' ? { market: input } : input;
    const seriesCodes = [...new Set(requestInput.seriesCodes ?? [])];
    if (seriesCodes.length === 0) {
      return this.routeMacro(requestInput, ctx, constraints);
    }
    const results = await Promise.all(seriesCodes.map((seriesCode) => this.routeMacro(
      { ...requestInput, seriesCodes: [seriesCode] },
      ctx,
      constraints,
      seriesCode,
    )));
    return mergeMacroResults(requestInput.market, results);
  }

  describeEquityScreener(
    market: Market,
    ctx: ConnectorRunContext = {},
    constraints?: RouteConstraints,
  ): Promise<ResearchResultV2<EquityScreenerDescriptor>> {
    return this.routeEquityScreener(market, ctx, { market }, (port, requestContext) =>
      port.describe(market, connectorContext(requestContext, ctx)), constraints);
  }

  screenEquities(
    query: ScreeningQuery,
    ctx: ConnectorRunContext = {},
    constraints?: RouteConstraints,
  ): Promise<ResearchResultV2<EquityScreenerSnapshot>> {
    return this.routeEquityScreener(query.market, ctx, query, (port, requestContext) =>
      port.screen(query, connectorContext(requestContext, ctx)), constraints);
  }

  private routeEquityScreener<T>(
    market: Market,
    ctx: ConnectorRunContext,
    input: unknown,
    operation: (port: EquityScreenerPort, context: SourceRequestContext) => Promise<SourceResult<T>>,
    constraints?: RouteConstraints,
  ): Promise<ResearchResultV2<T>> {
    const request = routeRequest('equity-screener', market, input, ctx, {
      ...(constraints ? { constraints } : {}),
    });
    return this.toV2(this.router.fetch(request, (source, requestContext) => {
      const port = source.ports.equityScreener;
      return port
        ? operation(port, requestContext)
        : Promise.resolve(unavailable(source.manifest.id, 'Source does not implement EquityScreenerPort.'));
    }));
  }

  private routeMacro(
    input: MacroInput,
    ctx: ConnectorRunContext,
    constraints?: RouteConstraints,
    seriesCode?: string,
  ): Promise<ResearchResultV2<MacroSnapshot>> {
    const request = routeRequest('macro', input.market, input, ctx, {
      dataSet: 'macro-series',
      ...(seriesCode ? { seriesCode } : {}),
      ...(constraints ? { constraints } : {}),
    });
    return this.toV2(this.router.fetch(request, async (source, requestContext) => {
      const port = source.ports.macro;
      return port
        ? port.fetchMacro(input, connectorContext(requestContext, ctx))
        : unavailable(source.manifest.id, 'Source does not implement MacroPort.');
    }));
  }

  getCorporateActions(
    input: CorporateActionsInput,
    ctx: ConnectorRunContext = {},
    constraints?: RouteConstraints,
  ): Promise<ResearchResultV2<CorporateAction[]>> {
    return this.routeInstrument('corporate-actions', input.instrumentId, ctx, input, async (source, requestContext) => {
      const port = source.ports.corporateActions;
      return port
        ? port.listActions(input, connectorContext(requestContext, ctx))
        : unavailable(source.manifest.id, 'Source does not implement CorporateActionsPort.');
    }, undefined, input.dataSet, constraints);
  }

  getOwnership(
    input: OwnershipInput,
    ctx: ConnectorRunContext = {},
    constraints?: RouteConstraints,
  ): Promise<ResearchResultV2<OwnershipObservation[]>> {
    return this.routeInstrument('ownership', input.instrumentId, ctx, input, async (source, requestContext) => {
      const port = source.ports.ownership;
      return port
        ? port.listOwnership(input, connectorContext(requestContext, ctx))
        : unavailable(source.manifest.id, 'Source does not implement OwnershipPort.');
    }, undefined, input.dataSet, constraints);
  }

  getMarketEvents(
    input: MarketEventsInput,
    ctx: ConnectorRunContext = {},
    constraints?: RouteConstraints,
  ): Promise<ResearchResultV2<MarketEvent[]>> {
    return this.routeInstrument('market-events', input.instrumentId, ctx, input, async (source, requestContext) => {
      const port = source.ports.marketEvents;
      return port
        ? port.listEvents(input, connectorContext(requestContext, ctx))
        : unavailable(source.manifest.id, 'Source does not implement MarketEventsPort.');
    }, undefined, input.dataSet, constraints);
  }

  getMarketSession(market: MarketCode, at?: string): Promise<ResearchResultV2<MarketSession>> {
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
    return this.toV2(this.router.fetch(request, async (source, requestContext) => {
      const port = source.ports.instrumentSearch;
      if (!port) return unavailable(source.manifest.id, 'Source does not implement InstrumentSearchPort.');
      return port.search(normalized, requestContext.signal ?? signal);
    }, { merge: (results) => mergeInstrumentSearch(results, normalized) }));
  }

  private async routeInstrument<T>(
    capability: RouteRequest['capability'],
    instrumentId: string,
    ctx: ConnectorRunContext,
    input: unknown,
    operation: (source: SourceInstance, context: SourceRequestContext) => Promise<SourceResult<T>>,
    interval?: RouteRequest['interval'],
    dataSet?: RouteRequest['dataSet'],
    constraints?: RouteConstraints,
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
    const request = routeRequest(capability, parsed.market, input, ctx, {
      ...(interval ? { interval } : {}),
      ...(dataSet ? { dataSet } : {}),
      ...(constraints ? { constraints } : {}),
      instrumentId: parsed.raw,
    });
    request.securityType = parsed.symbol.startsWith('^') ? 'index' : 'stock';
    return this.toV2(this.router.fetch(request, operation));
  }

  private toV2<T>(result: Promise<RoutedResult<T>> | RoutedResult<T>): Promise<ResearchResultV2<T>> {
    return Promise.resolve(result).then((value) => {
      const trace = {
        attempts: value.attempts,
        ...((value.status === 'ok' || value.status === 'partial') && value.selectedSource
          ? { selectedSource: value.selectedSource }
          : {}),
        ...((value.status === 'ok' || value.status === 'partial') && value.mergedSources
          ? { mergedSources: value.mergedSources }
          : {}),
      };
      if (value.status === 'ok' || value.status === 'partial') {
        return { schemaVersion: '2.0', status: value.status, data: value.data, citations: value.citations, freshness: value.freshness, warnings: value.warnings, trace };
      }
      return { schemaVersion: '2.0', status: value.status, data: null, citations: value.citations, freshness: value.freshness, warnings: value.warnings, trace, ...(value.error ? { error: value.error } : {}) };
    });
  }
}

export function createMarketData(options: CreateMarketDataOptions = {}): ResearchMarketDataClient {
  const registry = new SourceRegistry();
  for (const plugin of createBuiltInSourcePlugins(createDefaultProviderPorts(options))) {
    registry.registerPlugin(plugin, {});
  }
  registry.registerPlugin(createNbsMacroSourcePlugin(), {});
  for (const source of options.officialMacroFiles ?? []) {
    registry.registerPlugin(createOfficialMacroFileSourcePlugin(source), { enabled: source.enabled });
  }
  if (options.tushare?.token.trim() && options.tushare.enabledDataSets.length > 0) {
    registry.registerPlugin(createTushareSourcePlugin(), options.tushare);
  }
  if (options.massive?.apiKey.trim() && options.massive.enabledCapabilities.length > 0) {
    registry.registerPlugin(createMassiveSourcePlugin(), options.massive);
  }
  return createResearchMarketDataClient(registry, options);
}

export function createResearchMarketDataClient(
  sources: readonly SourceInstance[] | SourceRegistry,
  options: ResearchMarketDataClientOptions = {},
): ResearchMarketDataClient {
  return new ResearchMarketDataClient(sources instanceof SourceRegistry ? sources : new SourceRegistry(sources), options);
}

function createDefaultProviderPorts(options: CreateMarketDataOptions = {}) {
  const secUserAgent = options.secUserAgent?.trim() || DEFAULT_SEC_USER_AGENT;
  const hkFilings = createHkexFilingsConnector();
  return {
    ...(options.twelveDataApiKey?.trim() ? { twelveData: createTwelveDataFinanceConnector({ apiKey: options.twelveDataApiKey.trim() }) } : {}),
    ...(options.alphaVantageApiKey?.trim() ? { alphaVantage: createAlphaVantageFinanceConnector({ apiKey: options.alphaVantageApiKey.trim() }) } : {}),
    ...(options.eodhdApiKey?.trim() ? { eodhd: createEodhdFinanceConnector({ apiKey: options.eodhdApiKey.trim() }) } : {}),
    yahoo: createYahooFinanceConnector(),
    nasdaq: createNasdaqFinanceConnector(),
    sinaUs: createSinaUsFinanceConnector(),
    tencentHk: createTencentHkFinanceConnector(),
    tencentCn: createTencentCnFinanceConnector(),
    cnFinance: createCnFinanceConnector(),
    secProfile: createSecEdgarProfileConnector({ userAgent: secUserAgent }),
    hkProfile: createEastmoneyHkProfileConnector(),
    usFinancials: createSecEdgarXbrlFinancialsConnector({ userAgent: secUserAgent }),
    cnFinancials: createEastmoneyFinancialsConnector(),
    hkFinancials: createEastmoneyHkFinancialsConnector(),
    hkexFinancials: createHkexDerivedFinancialsConnector({ filings: hkFilings }),
    usFilings: createSecEdgarFilingsConnector({ userAgent: secUserAgent }),
    cnFilings: createCnFilingsConnector(),
    hkFilings,
    hkCorporateActions: createHkexDerivedCorporateActionsConnector(hkFilings),
    hkEvents: createHkexDerivedMarketEventsConnector(hkFilings),
    ...(options.sfcShortPositionCsvUrl?.trim()
      ? { hkOwnership: createSfcShortPositionConnector({ csvUrl: options.sfcShortPositionCsvUrl.trim() }) }
      : {}),
    macro: createOfficialMacroConnector(),
    cnOwnership: createCnPublicOwnershipConnector(),
    cnEvents: createCnPublicMarketEventsConnector(),
    cnEquityScreener: createEastmoneyEquityScreenerConnector(),
    instrumentSearch: [new EastMoneyInstrumentSearchProvider(), new TencentInstrumentSearchProvider(), new YahooInstrumentSearchProvider()],
  };
}

function routeRequest(
  capability: RouteRequest['capability'],
  market: SupportedMarket,
  input: unknown,
  ctx: ConnectorRunContext,
  options: Pick<RouteRequest, 'interval' | 'instrumentId' | 'dataSet' | 'seriesCode' | 'constraints'> = {},
): RouteRequest {
  return {
    capability,
    market,
    input,
    credentialScope: 'public',
    ...(ctx.signal ? { signal: ctx.signal } : {}),
    ...(ctx.timeoutMs ? { timeoutMs: ctx.timeoutMs } : {}),
    ...options,
  };
}

function connectorContext(context: SourceRequestContext, original: ConnectorRunContext): ConnectorRunContext {
  return {
    ...original,
    signal: context.signal ?? original.signal,
    timeoutMs: context.timeoutMs,
    ...(context.resolvedInstrument ? { resolvedInstrument: context.resolvedInstrument } : {}),
  };
}

function mergeInstrumentSearch(
  results: readonly SourceResult<InstrumentSearchResult[]>[],
  query: string,
): InstrumentSearchResult[] | null {
  const seen = new Set<string>();
  const merged = results.flatMap((result) => result.status === 'ok' ? result.data : []).filter((item) => {
    const key = `${item.market}:${item.symbol}:${item.exchange}`.toUpperCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return merged.length > 0 ? rankInstrumentSearchResults(merged, query) : null;
}

function isSupportedMarket(market: string | undefined): market is SupportedMarket {
  return market === 'US' || market === 'CN' || market === 'HK';
}

function mergeMacroResults(
  market: MacroInput['market'],
  results: readonly ResearchResultV2<MacroSnapshot>[],
): ResearchResultV2<MacroSnapshot> {
  const usable = results.filter((result) => result.status === 'ok' || result.status === 'partial');
  const attempts = results.flatMap((result) => result.trace.attempts);
  if (usable.length === 0) {
    const failed = results.find((result) => result.status === 'failed') ?? results[0];
    return failed ?? {
      schemaVersion: '2.0',
      status: 'empty',
      data: null,
      citations: [],
      freshness: [],
      warnings: [],
      trace: { attempts },
    };
  }
  const observations = usable
    .flatMap((result) => result.data.observations)
    .filter((observation, index, all) => all.findIndex((candidate) =>
      candidate.seriesCode === observation.seriesCode &&
      candidate.periodEnd === observation.periodEnd &&
      candidate.seasonalAdjustment === observation.seasonalAdjustment,
    ) === index)
    .sort((left, right) => left.seriesCode.localeCompare(right.seriesCode) || right.periodEnd.localeCompare(left.periodEnd));
  const incomplete = usable.length !== results.length || usable.some((result) => result.status === 'partial');
  return {
    schemaVersion: '2.0',
    status: incomplete ? 'partial' : 'ok',
    data: { market, observations },
    citations: dedupeBy(usable.flatMap((result) => result.citations), (item) => `${item.provider}:${item.url ?? ''}`),
    freshness: dedupeBy(usable.flatMap((result) => result.freshness), (item) => `${item.provider}:${item.asOf}`),
    warnings: dedupeBy(results.flatMap((result) => result.warnings), (item) => `${item.provider ?? ''}:${item.code}:${item.message}`),
    trace: {
      attempts,
      mergedSources: [...new Set(usable.flatMap((result) => result.trace.mergedSources ?? (result.trace.selectedSource ? [result.trace.selectedSource] : [])))],
    },
  };
}

function dedupeBy<T>(values: readonly T[], key: (value: T) => string): T[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const candidate = key(value);
    if (seen.has(candidate)) return false;
    seen.add(candidate);
    return true;
  });
}
