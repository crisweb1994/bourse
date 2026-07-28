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
import { createTavilySearchConnector } from './connectors/search/tavily';
import { EastMoneyInstrumentSearchProvider } from './connectors/instrument-search/eastmoney';
import { TencentInstrumentSearchProvider } from './connectors/instrument-search/tencent';
import { YahooInstrumentSearchProvider } from './connectors/instrument-search/yahoo';
import type { ConnectorRunContext } from './connectors/types';
import type { ResearchResult } from './contracts/result';
import type { FilingPort, FilingSummary } from './ports/filings';
import type {
  CompanyProfile,
  CompanyProfilePort,
  FinancePort,
  HistoryInput,
  PriceBar,
  Quote,
} from './ports/finance';
import type { FinancialsBundle, FinancialsPort } from './ports/financials';
import type { MacroPort, MacroSnapshot } from './ports/macro';
import type { SearchPort, WebSearchInput, WebSearchResultItem } from './ports/search';
import type {
  InstrumentSearchPort,
  InstrumentSearchResult,
} from './ports/instrument-search';
import { sourcePriority, type SupportedMarket } from './sources';

const DEFAULT_SEC_USER_AGENT = 'stock-suggest-research contact@example.com';

export interface MarketDataProviders {
  twelveData?: FinancePort;
  alphaVantage?: FinancePort;
  eodhd?: FinancePort;
  yahoo: FinancePort;
  nasdaq: FinancePort;
  sinaUs: FinancePort;
  tencentHk: FinancePort;
  tencentCn?: FinancePort;
  cnFinance: FinancePort;
  secProfile: CompanyProfilePort;
  hkProfile?: CompanyProfilePort;
  usFinancials: FinancialsPort;
  cnFinancials: FinancialsPort;
  hkFinancials: FinancialsPort;
  usFilings: FilingPort;
  cnFilings: FilingPort;
  hkFilings: FilingPort;
  macro: MacroPort;
  search: SearchPort | null;
  instrumentSearch?: readonly InstrumentSearchPort[];
}

export interface CreateMarketDataOptions {
  secUserAgent?: string;
  tavilyApiKey?: string;
  twelveDataApiKey?: string;
  alphaVantageApiKey?: string;
  eodhdApiKey?: string;
  providers?: Partial<MarketDataProviders>;
}

export interface MarketDataBundle {
  instrumentId: string;
  capturedAt: string;
  quote: ResearchResult<Quote>;
  history: ResearchResult<PriceBar[]>;
  profile: ResearchResult<CompanyProfile | null>;
  financials: ResearchResult<FinancialsBundle | null>;
  filings: ResearchResult<FilingSummary[]>;
  macro: ResearchResult<MacroSnapshot>;
  search?: ResearchResult<WebSearchResultItem[]>;
}

export interface GetBundleOptions extends ConnectorRunContext {
  historyFrom: string;
  historyTo: string;
  filingsLimit?: number;
  search?: WebSearchInput;
}

export class MarketDataClient {
  constructor(private readonly providers: MarketDataProviders) {}

  get hasSearchProvider(): boolean {
    return this.providers.search !== null;
  }

  async searchInstruments(
    query: string,
    signal?: AbortSignal,
  ): Promise<InstrumentSearchResult[]> {
    const normalized = query.trim();
    if (!normalized) return [];
    for (const provider of this.providers.instrumentSearch ?? []) {
      const results = await provider.search(normalized, signal);
      if (results.length > 0) return results;
    }
    return [];
  }

  getQuote(
    instrumentId: string,
    ctx: ConnectorRunContext = {},
  ): Promise<ResearchResult<Quote>> {
    const market = marketFromInstrumentId(instrumentId);
    return fallback(
      orderedFinanceSources(this.providers, market, 'quote').map(([id, name, port]) => [
        name,
        () => port.getQuote({ instrumentId }, sourceContext(ctx, sourceTimeout(id, market, 'quote'))),
      ] as const),
      hasUsableQuote,
      'quote',
    );
  }

  async getHistory(
    input: HistoryInput,
    ctx: ConnectorRunContext = {},
  ): Promise<ResearchResult<PriceBar[]>> {
    const market = marketFromInstrumentId(input.instrumentId);
    return fallback(
      orderedFinanceSources(this.providers, market, 'history').map(([id, name, port]) => [
        name,
        () => port.getHistory(input, sourceContext(ctx, sourceTimeout(id, market, 'history'))),
      ] as const),
      hasUsableHistory,
      'history',
    );
  }

  async getProfile(
    instrumentId: string,
    ctx: ConnectorRunContext = {},
  ): Promise<ResearchResult<CompanyProfile | null>> {
    const market = marketFromInstrumentId(instrumentId);
    return profileFallback(orderedProfileSources(this.providers, market), instrumentId, ctx);
  }

  getFinancials(
    instrumentId: string,
    ctx: ConnectorRunContext = {},
  ): Promise<ResearchResult<FinancialsBundle | null>> {
    const market = marketFromInstrumentId(instrumentId);
    const port = market === 'US'
      ? this.providers.usFinancials
      : market === 'CN'
        ? this.providers.cnFinancials
        : this.providers.hkFinancials;
    return port.fetchFinancials({ instrumentId }, ctx);
  }

  getFilings(
    instrumentId: string,
    limit = 10,
    ctx: ConnectorRunContext = {},
  ): Promise<ResearchResult<FilingSummary[]>> {
    const market = marketFromInstrumentId(instrumentId);
    if (market === 'US') return fetchUsFilings(this.providers.usFilings, instrumentId, limit, ctx);
    const port = market === 'CN' ? this.providers.cnFilings : this.providers.hkFilings;
    return port.searchFilings({ instrumentId, limit }, ctx);
  }

  getMacro(
    market: SupportedMarket,
    ctx: ConnectorRunContext = {},
  ): Promise<ResearchResult<MacroSnapshot>> {
    return this.providers.macro.fetchMacro({ market }, ctx);
  }

  searchWeb(
    input: WebSearchInput,
    ctx: ConnectorRunContext = {},
  ): Promise<ResearchResult<WebSearchResultItem[]>> | null {
    return this.providers.search?.searchWeb(input, ctx) ?? null;
  }

  async getBundle(
    instrumentId: string,
    options: GetBundleOptions,
  ): Promise<MarketDataBundle> {
    const market = marketFromInstrumentId(instrumentId);
    const ctx: ConnectorRunContext = {
      ...(options.fetchLike ? { fetchLike: options.fetchLike } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.disableSummaryDetail !== undefined
        ? { disableSummaryDetail: options.disableSummaryDetail }
        : {}),
    };
    const searchPromise = options.search ? this.searchWeb(options.search, ctx) : null;
    const [quote, history, profile, financials, filings, macro, search] = await Promise.all([
      this.getQuote(instrumentId, ctx),
      this.getHistory({
        instrumentId,
        from: options.historyFrom,
        to: options.historyTo,
        interval: '1d',
      }, ctx),
      this.getProfile(instrumentId, ctx),
      this.getFinancials(instrumentId, ctx),
      this.getFilings(instrumentId, options.filingsLimit ?? 10, ctx),
      this.getMacro(market, ctx),
      searchPromise,
    ]);
    return {
      instrumentId,
      capturedAt: new Date().toISOString(),
      quote,
      history,
      profile,
      financials,
      filings,
      macro,
      ...(search ? { search } : {}),
    };
  }
}

export function createMarketData(options: CreateMarketDataOptions = {}): MarketDataClient {
  return new MarketDataClient(createMarketDataProviders(options));
}

export function createMarketDataProviders(
  options: CreateMarketDataOptions = {},
): MarketDataProviders {
  const secUserAgent = options.secUserAgent?.trim() || DEFAULT_SEC_USER_AGENT;
  const supplied = options.providers ?? {};
  return {
    ...(supplied.twelveData
      ? { twelveData: supplied.twelveData }
      : options.twelveDataApiKey?.trim()
        ? { twelveData: createTwelveDataFinanceConnector({ apiKey: options.twelveDataApiKey.trim() }) }
        : {}),
    ...(supplied.alphaVantage
      ? { alphaVantage: supplied.alphaVantage }
      : options.alphaVantageApiKey?.trim()
        ? { alphaVantage: createAlphaVantageFinanceConnector({ apiKey: options.alphaVantageApiKey.trim() }) }
        : {}),
    ...(supplied.eodhd
      ? { eodhd: supplied.eodhd }
      : options.eodhdApiKey?.trim()
        ? { eodhd: createEodhdFinanceConnector({ apiKey: options.eodhdApiKey.trim() }) }
        : {}),
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
    search: Object.prototype.hasOwnProperty.call(supplied, 'search')
      ? supplied.search ?? null
      : options.tavilyApiKey?.trim()
        ? createTavilySearchConnector({ apiKey: options.tavilyApiKey.trim() })
        : null,
    instrumentSearch: supplied.instrumentSearch ?? [
      new EastMoneyInstrumentSearchProvider(),
      new TencentInstrumentSearchProvider(),
      new YahooInstrumentSearchProvider(),
    ],
  };
}

function marketFromInstrumentId(instrumentId: string): SupportedMarket {
  const market = instrumentId.split(':', 1)[0];
  if (market === 'US' || market === 'CN' || market === 'HK') return market;
  throw new Error(`Unsupported instrumentId: ${instrumentId}`);
}

function sourceContext(ctx: ConnectorRunContext, timeoutMs: number): ConnectorRunContext {
  return { ...ctx, timeoutMs: Math.min(ctx.timeoutMs ?? timeoutMs, timeoutMs) };
}

type FinanceSource = readonly [id: string, name: string, port: FinancePort];

function orderedFinanceSources(
  providers: MarketDataProviders,
  market: SupportedMarket,
  kind: 'quote' | 'history',
): FinanceSource[] {
  return sourcePriority(market, kind).flatMap((id): FinanceSource[] => {
    const source = financeSource(providers, id);
    return source ? [[id, source.name, source.port]] : [];
  });
}

function orderedProfileSources(
  providers: MarketDataProviders,
  market: SupportedMarket,
): Array<readonly [string, CompanyProfilePort, 'OTHER' | 'FILING']> {
  return sourcePriority(market, 'profile').flatMap((id): Array<readonly [string, CompanyProfilePort, 'OTHER' | 'FILING']> => {
    if (id === 'sec-edgar-profile') {
      return [['SEC issuer-profile', providers.secProfile, 'FILING'] as const];
    }
    if (id === 'eastmoney-hk-profile') {
      return providers.hkProfile
        ? [['Eastmoney HK profile', providers.hkProfile, 'OTHER'] as const]
        : [];
    }
    const source = financeSource(providers, id);
    if (!source?.port.getProfile) return [];
    return [[
      source.name,
      { getProfile: source.port.getProfile.bind(source.port) },
      'OTHER',
    ] as const];
  });
}

function financeSource(
  providers: MarketDataProviders,
  id: string,
): { name: string; port: FinancePort } | null {
  switch (id) {
    case 'twelve-data': return providers.twelveData ? { name: 'Twelve Data', port: providers.twelveData } : null;
    case 'alpha-vantage': return providers.alphaVantage ? { name: 'Alpha Vantage', port: providers.alphaVantage } : null;
    case 'eodhd': return providers.eodhd ? { name: 'EODHD', port: providers.eodhd } : null;
    case 'yahoo': return { name: 'Yahoo', port: providers.yahoo };
    case 'nasdaq': return { name: 'Nasdaq', port: providers.nasdaq };
    case 'sina': return { name: 'Sina Finance', port: providers.sinaUs };
    case 'tencent-hk': return { name: 'Tencent Finance', port: providers.tencentHk };
    case 'cn-finance': return { name: 'Eastmoney', port: providers.cnFinance };
    case 'tencent-cn-history': return providers.tencentCn ? { name: 'Tencent Finance', port: providers.tencentCn } : null;
    default: return null;
  }
}

function sourceTimeout(
  id: string,
  market: SupportedMarket,
  kind: 'quote' | 'history',
): number {
  if (id === 'twelve-data' || id === 'alpha-vantage' || id === 'eodhd') return 5_000;
  if (market === 'US') return kind === 'quote' ? 1_500 : id === 'sina' ? 4_500 : 1_500;
  if (id === 'yahoo') return 2_000;
  if (id === 'tencent-hk' && kind === 'history') return 4_000;
  return 5_000;
}

function hasUsableQuote(quote: Quote): boolean {
  return Number.isFinite(quote.price) && quote.price > 0;
}

function hasUsableHistory(history: PriceBar[]): boolean {
  return history.filter((bar) =>
    Number.isFinite(bar.close) &&
    bar.close > 0 &&
    typeof bar.timestamp === 'string' &&
    !Number.isNaN(Date.parse(bar.timestamp)),
  ).length >= 20;
}

function hasUsableProfile(profile: CompanyProfile | null | undefined): profile is CompanyProfile {
  return Boolean(
    profile &&
    (profile.description || profile.sector || profile.industry || profile.website ||
      typeof profile.employees === 'number'),
  );
}

async function profileFallback(
  sources: ReadonlyArray<readonly [string, CompanyProfilePort, 'OTHER' | 'FILING']>,
  instrumentId: string,
  ctx: ConnectorRunContext,
): Promise<ResearchResult<CompanyProfile | null>> {
  const priorWarnings: ResearchResult<CompanyProfile>['warnings'] = [];
  let last: ResearchResult<CompanyProfile> | undefined;
  for (let index = 0; index < sources.length; index += 1) {
    const [name, port, sourceType] = sources[index]!;
    try {
      const result = await port.getProfile({ instrumentId }, sourceContext(ctx, 5_000));
      last = result;
      if (!hasUsableProfile(result.data)) {
        priorWarnings.push(...result.warnings);
        continue;
      }
      if (index === 0) return result;
      const unavailable = sources.slice(0, index).map(([source]) => source).join(' and ');
      return {
        ...result,
        warnings: [
          ...priorWarnings,
          ...result.warnings,
          {
            code: 'PARTIAL_DATA',
            message: `${unavailable} profile ${index === 1 ? 'was' : 'were'} unavailable; ${name} fallback was used.`,
            provider: result.citations[0]?.provider ?? name.toLowerCase(),
            sourceType,
          },
        ],
      };
    } catch (error) {
      priorWarnings.push({
        code: warningCode(error),
        message: `${name} profile failed: ${errorMessage(error)}`,
        provider: name.toLowerCase(),
        sourceType,
      });
    }
  }
  if (!last) throw new Error('All profile providers failed.');
  return { ...last, data: null, warnings: priorWarnings };
}

async function fallback<T>(
  sources: ReadonlyArray<readonly [string, () => Promise<ResearchResult<T>>]>,
  usable: (data: T) => boolean,
  fact: 'quote' | 'history',
): Promise<ResearchResult<T>> {
  const priorWarnings: ResearchResult<T>['warnings'] = [];
  let last: ResearchResult<T> | undefined;
  let lastError: unknown;
  for (let index = 0; index < sources.length; index += 1) {
    const [name, call] = sources[index]!;
    try {
      const result = await call();
      last = result;
      if (usable(result.data)) {
        if (index === 0) return result;
        const unavailable = sources.slice(0, index).map(([source]) => source).join(' and ');
        return {
          ...result,
          warnings: [
            ...priorWarnings,
            ...result.warnings,
            {
              code: 'PARTIAL_DATA',
              message: `${unavailable} ${fact} ${index === 1 ? 'was' : 'were'} unavailable; ${name} fallback was used.`,
              provider: result.citations[0]?.provider ?? name.toLowerCase(),
              sourceType: 'PRICE',
            },
          ],
        };
      }
      priorWarnings.push(...result.warnings);
    } catch (error) {
      lastError = error;
      priorWarnings.push({
        code: warningCode(error),
        message: `${name} ${fact} failed: ${errorMessage(error)}`,
        provider: name.toLowerCase(),
        sourceType: 'PRICE',
      });
    }
  }
  if (!last) throw lastError instanceof Error ? lastError : new Error(`All ${fact} providers failed.`);
  return { ...last, warnings: priorWarnings };
}

function warningCode(error: unknown): 'AUTH_REQUIRED' | 'RATE_LIMITED' | 'SOURCE_UNAVAILABLE' {
  const message = errorMessage(error);
  if (/401|403|auth/i.test(message)) return 'AUTH_REQUIRED';
  if (/429|rate.?limit/i.test(message)) return 'RATE_LIMITED';
  return 'SOURCE_UNAVAILABLE';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function fetchUsFilings(
  filings: FilingPort,
  instrumentId: string,
  limit: number,
  ctx: ConnectorRunContext,
): Promise<ResearchResult<FilingSummary[]>> {
  const [company, insider] = await Promise.all([
    filings.searchFilings({
      instrumentId,
      forms: ['10-K', '10-K/A', '10-Q', '10-Q/A', '8-K', '8-K/A', 'DEF 14A'],
      limit,
    }, ctx),
    filings.searchFilings({
      instrumentId,
      forms: ['3', '3/A', '4', '4/A', '5', '5/A'],
      limit,
    }, ctx),
  ]);
  const seen = new Set<string>();
  const data = [...company.data, ...insider.data]
    .filter((filing) => {
      const key = filing.sourceDocumentId || filing.id || filing.filingUrl;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => b.filingDate.localeCompare(a.filingDate))
    .slice(0, Math.max(limit, 1) * 2);
  return {
    schemaVersion: company.schemaVersion,
    data,
    citations: [...company.citations, ...insider.citations].filter((citation, index, all) =>
      all.findIndex((item) => item.url === citation.url) === index,
    ),
    freshness: [...company.freshness, ...insider.freshness],
    warnings: [...company.warnings, ...insider.warnings],
  };
}
