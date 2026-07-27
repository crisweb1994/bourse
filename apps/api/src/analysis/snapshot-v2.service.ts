import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  defineMarketConfig,
  fetchSnapshot,
  portToFetcher,
  snapshotToEvidencePack,
  type MarketConfigMap,
  type StockSnapshot,
  type ToEvidencePackOptions,
} from '@bourse/analysis';
import {
  akshareNorthboundCN,
  consensusEpsCN,
  lhbScanCN,
  shareholdersCN,
  unlockCalendarCN,
  type EvidencePackV2,
  type ToolContext,
  type ToolDescriptor,
} from '@bourse/analysis';
import { getMarket } from '@bourse/analysis';
import type {
  CompanyProfile,
  CompanyProfilePort,
  FilingPort,
  FilingSummary,
  FinancePort,
  FinancialsPort,
  MacroPort,
  PriceBar,
  ResearchCitation,
  ResearchResult,
  SearchPort,
  Quote,
} from '@bourse/analysis';
import {
  CN_FILING_PORT,
  CN_FINANCE_PORT,
  CN_FINANCIALS_PORT,
  HK_FINANCIALS_PORT,
  HK_FILING_PORT,
  NASDAQ_FINANCE_PORT,
  SINA_US_FINANCE_PORT,
  TENCENT_HK_FINANCE_PORT,
  OFFICIAL_MACRO_PORT,
  TAVILY_SEARCH_PORT,
  US_PROFILE_PORT,
  US_FILING_PORT,
  US_FINANCIALS_PORT,
  YAHOO_FINANCE_PORT,
} from '../connectors/connectors.module';

/**
 * API-side data preparation boundary. It wires the app connector ports into
 * `@bourse/analysis` snapshot fetching, then projects snapshots into
 * EvidencePackV2 for the analysis workflow.
 */
@Injectable()
export class SnapshotV2Service {
  private readonly logger = new Logger(SnapshotV2Service.name);
  private readonly configs: MarketConfigMap;

  constructor(
    @Inject(YAHOO_FINANCE_PORT) private readonly yahoo: FinancePort,
    @Inject(NASDAQ_FINANCE_PORT) private readonly nasdaq: FinancePort,
    @Inject(SINA_US_FINANCE_PORT) private readonly sinaUs: FinancePort,
    @Inject(TENCENT_HK_FINANCE_PORT) private readonly tencentHk: FinancePort,
    @Inject(US_PROFILE_PORT) private readonly usProfile: CompanyProfilePort,
    @Inject(CN_FINANCE_PORT) private readonly cnFinance: FinancePort,
    @Inject(US_FINANCIALS_PORT) private readonly usFinancials: FinancialsPort,
    @Inject(CN_FINANCIALS_PORT) private readonly cnFinancials: FinancialsPort,
    @Inject(HK_FINANCIALS_PORT) private readonly hkFinancials: FinancialsPort,
    @Inject(US_FILING_PORT) private readonly usFilings: FilingPort,
    @Inject(CN_FILING_PORT) private readonly cnFilings: FilingPort,
    @Inject(HK_FILING_PORT) private readonly hkFilings: FilingPort,
    @Inject(OFFICIAL_MACRO_PORT) private readonly macro: MacroPort,
    @Inject(TAVILY_SEARCH_PORT) private readonly tavilySearch: SearchPort | null,
  ) {
    this.configs = this.buildConfigs();
  }

  /**
   * Fetch a snapshot and project it to an EvidencePackV2. EvidencePackService
   * owns the analysis-facing build policy; this method keeps the connector
   * fetch + projection step reusable and safe to call concurrently.
   */
  async fetchAsEvidencePack(
    symbol: string,
    market: 'US' | 'CN' | 'HK',
    options?: ToEvidencePackOptions & {
      perConnectorTimeoutMs?: number;
      historyDays?: number;
      filingsLimit?: number;
      signal?: AbortSignal;
    },
  ): Promise<EvidencePackV2> {
    const snap = await this.fetch(symbol, market, options);
    return snapshotToEvidencePack(snap, {
      planId: options?.planId,
      snapshotId: options?.snapshotId,
    });
  }

  async fetch(
    symbol: string,
    market: 'US' | 'CN' | 'HK',
    options?: {
      perConnectorTimeoutMs?: number;
      historyDays?: number;
      filingsLimit?: number;
      signal?: AbortSignal;
    },
  ): Promise<StockSnapshot> {
    const startedAt = Date.now();
    try {
      const snap = await fetchSnapshot({
        symbol,
        market,
        configs: this.configs,
        perConnectorTimeoutMs: options?.perConnectorTimeoutMs,
        historyDays: options?.historyDays,
        filingsLimit: options?.filingsLimit,
        signal: options?.signal,
      });
      this.logger.debug?.(
        `fetchSnapshot ${market}:${symbol} ok available=${snap.dataAvailability.available.length} missing=${snap.dataAvailability.missing.length} (${Date.now() - startedAt}ms)`,
      );
      return snap;
    } catch (err) {
      this.logger.error(
        `fetchSnapshot ${market}:${symbol} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw err;
    }
  }

  // --------------------------------------------------------------------------
  // Config wiring
  // --------------------------------------------------------------------------

  private buildConfigs(): MarketConfigMap {
    // Quote / history come off the FinancePort; financials off the
    // FinancialsPort. We use the same `instrumentId` shape (US:AAPL /
    // CN:600519 / HK:0700) that research-core ports expect.

    const instrumentId = (market: 'US' | 'CN' | 'HK', symbol: string): string =>
      `${market}:${symbol}`;

    return {
      US: defineMarketConfig('US', 'USD', {
        quote: async (symbol, ctx) => withUsMarketFallback([
          ['Yahoo', () => this.yahoo.getQuote({ instrumentId: instrumentId('US', symbol) }, sourceContext(ctx, 1_500))],
          ['Nasdaq', () => this.nasdaq.getQuote({ instrumentId: instrumentId('US', symbol) }, sourceContext(ctx, 1_500))],
          ['Sina Finance', () => this.sinaUs.getQuote({ instrumentId: instrumentId('US', symbol) }, sourceContext(ctx, 4_500))],
        ],
          hasUsableQuote,
          'quote',
        ),
        history: async (symbol, from, to, ctx) => {
          return withUsMarketFallback([
            ['Yahoo', () => this.yahoo.getHistory(
              { instrumentId: instrumentId('US', symbol), from, to, interval: '1d' },
              sourceContext(ctx, 1_500),
            )],
            ['Nasdaq', () => this.nasdaq.getHistory(
              { instrumentId: instrumentId('US', symbol), from, to, interval: '1d' },
              sourceContext(ctx, 1_500),
            )],
            ['Sina Finance', () => this.sinaUs.getHistory(
              { instrumentId: instrumentId('US', symbol), from, to, interval: '1d' },
              sourceContext(ctx, 4_500),
            )],
          ],
            hasUsableHistory,
            'history',
          );
        },
        profile: async (symbol, ctx) => {
          const yahoo = await this.yahoo.getProfile!(
            { instrumentId: instrumentId('US', symbol) },
            ctx,
          );
          const yahooProfile = profileEnvelopeToFact(yahoo.data);
          if (yahooProfile) return { ...yahoo, data: yahooProfile };
          const sec = await this.usProfile.getProfile(
            { instrumentId: instrumentId('US', symbol) },
            ctx,
          );
          const secProfile = profileEnvelopeToFact(sec.data);
          if (!secProfile) return { ...sec, data: null };
          return {
            ...sec,
            data: secProfile,
            warnings: [
              ...sec.warnings,
              {
                code: 'PARTIAL_DATA',
                message: 'Yahoo profile was unavailable; SEC issuer-profile fallback was used.',
                provider: 'sec-edgar-profile',
                sourceType: 'FILING',
              },
            ],
          };
        },
        financials: portToFetcher((symbol, ctx) =>
          this.usFinancials.fetchFinancials(
            { instrumentId: instrumentId('US', symbol) },
            ctx,
          ),
        ),
        filings: async (symbol, limit, ctx) => {
          return fetchUsFilings(
            this.usFilings,
            instrumentId('US', symbol),
            limit,
            ctx,
          );
        },
        macro: portToFetcher((_, ctx) =>
          this.macro.fetchMacro({ market: 'US' }, ctx),
        ),
        ...(this.tavilySearch
          ? {
              webSearch: portToFetcher((symbol, ctx) =>
                this.tavilySearch!.searchWeb(
                  searchQuery('US', symbol),
                  ctx,
                ),
              ),
            }
          : {}),
      }),
      CN: defineMarketConfig('CN', 'CNY', {
        quote: portToFetcher((symbol, ctx) =>
          this.cnFinance.getQuote({ instrumentId: instrumentId('CN', symbol) }, ctx),
        ),
        history: async (symbol, from, to, ctx) => {
          const env = await this.cnFinance.getHistory(
            { instrumentId: instrumentId('CN', symbol), from, to, interval: '1d' },
            ctx,
          );
          return env;
        },
        profile: async (symbol, ctx) => {
          const env = await this.cnFinance.getProfile!(
            { instrumentId: instrumentId('CN', symbol) },
            ctx,
          );
          return { ...env, data: profileEnvelopeToFact(env.data) };
        },
        financials: portToFetcher((symbol, ctx) =>
          this.cnFinancials.fetchFinancials(
            { instrumentId: instrumentId('CN', symbol) },
            ctx,
          ),
        ),
        filings: async (symbol, limit, ctx) => {
          const env = await this.cnFilings.searchFilings(
            { instrumentId: instrumentId('CN', symbol), limit },
            ctx,
          );
          return env;
        },
        // CN-only fact tools run through the same snapshot orchestrator;
        // failures surface in dataAvailability with structured reason codes.
        consensusEps: toolToFetcher(consensusEpsCN),
        lhb: toolToFetcher(lhbScanCN),
        northboundFlow: toolToFetcher(akshareNorthboundCN),
        unlockCalendar: toolToFetcher(unlockCalendarCN),
        shareholders: toolToFetcher(shareholdersCN),
        macro: portToFetcher((_, ctx) =>
          this.macro.fetchMacro({ market: 'CN' }, ctx),
        ),
        ...(this.tavilySearch
          ? {
              webSearch: portToFetcher((symbol, ctx) =>
                this.tavilySearch!.searchWeb(
                  searchQuery('CN', symbol),
                  ctx,
                ),
              ),
            }
          : {}),
      }),
      HK: defineMarketConfig('HK', 'HKD', {
        quote: async (symbol, ctx) => withUsMarketFallback([
          ['Yahoo', () => this.yahoo.getQuote({ instrumentId: instrumentId('HK', symbol) }, sourceContext(ctx, 2_000))],
          ['Tencent Finance', () => this.tencentHk.getQuote({ instrumentId: instrumentId('HK', symbol) }, sourceContext(ctx, 4_000))],
        ],
          hasUsableQuote,
          'quote',
        ),
        history: async (symbol, from, to, ctx) => {
          return withUsMarketFallback([
            ['Yahoo', () => this.yahoo.getHistory(
              { instrumentId: instrumentId('HK', symbol), from, to, interval: '1d' },
              sourceContext(ctx, 2_000),
            )],
            ['Tencent Finance', () => this.tencentHk.getHistory(
              { instrumentId: instrumentId('HK', symbol), from, to, interval: '1d' },
              sourceContext(ctx, 4_000),
            )],
          ],
            hasUsableHistory,
            'history',
          );
        },
        // HK financials via Eastmoney datacenter HK F10
        // (RPT_HKF10_FN_MAININDICATOR wide report). Reporting currency
        // resolved from RPT_HKF10_FN_INCOME.CURRENCY_CODE (Tencent → CNY).
        financials: portToFetcher((symbol, ctx) =>
          this.hkFinancials.fetchFinancials(
            { instrumentId: instrumentId('HK', symbol) },
            ctx,
          ),
        ),
        filings: async (symbol, limit, ctx) => {
          const env = await this.hkFilings.searchFilings(
            { instrumentId: instrumentId('HK', symbol), limit },
            ctx,
          );
          return env;
        },
        macro: portToFetcher((_, ctx) =>
          this.macro.fetchMacro({ market: 'HK' }, ctx),
        ),
        ...(this.tavilySearch
          ? {
              webSearch: portToFetcher((symbol, ctx) =>
                this.tavilySearch!.searchWeb(
                  searchQuery('HK', symbol),
                  ctx,
                ),
              ),
            }
          : {}),
      }),
    };
  }
}

/**
 * Wrap a CN ToolDescriptor as an ExtraFetcher. The descriptor's `run()`
 * takes (input, ctx); we shape input as `{symbol, market: 'CN'}` and
 * synthesize a minimal ToolContext with the CN MarketProfile + signal.
 *
 * Returns the raw ToolResult.data — fetchSnapshot stores it on
 * RawFacts; the adapter (snapshotToEvidencePack) projects it into the
 * EvidencePackV2 shape.
 *
 * Errors bubble to fetchSnapshot's classifyError path; tool 429s
 * become `rate_limited` via the message regex; .reason='not_implemented'
 * (akshareNorthboundCN's all-mirrors-failed path) becomes
 * `not_implemented`.
 */
function toolToFetcher(
  tool: ToolDescriptor<{ symbol: string; market: 'CN' }, unknown>,
): (symbol: string, ctx?: { signal?: AbortSignal }) => Promise<{
  data: unknown | null;
  citations: ResearchCitation[];
  freshness: Array<{
    provider: string;
    asOf: string;
    retrievedAt: string;
    stale: boolean;
  }>;
  warnings: [];
  cost?: unknown;
}> {
  return async (symbol, ctx) => {
    const retrievedAt = new Date().toISOString();
    if (!tool.run) {
      return {
        data: null,
        citations: [],
        freshness: [{ provider: tool.name, asOf: retrievedAt, retrievedAt, stale: true }],
        warnings: [],
      };
    }
    const toolCtx: ToolContext = {
      ...(ctx?.signal ? { signal: ctx.signal } : {}),
      ...(getMarket('CN') ? { marketProfile: getMarket('CN')! } : {}),
    };
    const result = await tool.run({ symbol, market: 'CN' }, toolCtx);
    return {
      data: result?.data ?? null,
      citations: (result?.citations ?? []).flatMap((citation) => {
        if (!citation.url) return [];
        return [{
          title: citation.title,
          url: citation.url,
          sourceType: toResearchSourceType(citation.sourceType),
          provider: tool.name,
          retrievedAt: citation.retrievedAt,
          ...(citation.qualityTier ? { qualityTier: citation.qualityTier } : {}),
        }];
      }),
      freshness: [{ provider: tool.name, asOf: retrievedAt, retrievedAt, stale: false }],
      warnings: [],
      ...(result?.cost ? { cost: result.cost } : {}),
    };
  };
}

function searchQuery(
  market: 'US' | 'CN' | 'HK',
  symbol: string,
): {
  query: string;
  limit: number;
  topic: 'finance';
  freshness: '30d';
  market: 'US' | 'CN' | 'HK';
} {
  const marketLabel = market === 'CN' ? 'A-share' : market === 'HK' ? 'Hong Kong' : 'US';
  return {
    query: `${symbol} ${marketLabel} company latest earnings governance regulatory risk`,
    limit: 8,
    topic: 'finance',
    freshness: '30d',
    market,
  };
}

function toResearchSourceType(
  sourceType: string,
): ResearchCitation['sourceType'] {
  switch (sourceType) {
    case 'NEWS':
    case 'FILING':
    case 'SOCIAL':
    case 'WEB':
    case 'PRICE':
    case 'MACRO':
    case 'RESEARCH':
    case 'OTHER':
      return sourceType;
    default:
      return 'OTHER';
  }
}

/**
 * Yahoo remains the preferred US source because it exposes richer quote
 * fields. Nasdaq is queried only when Yahoo returns a sentinel or empty daily
 * history. The Nasdaq envelope owns the citation, and the warning makes the
 * source transition visible to downstream analysis and users.
 */
async function withUsMarketFallback<T>(
  sources: ReadonlyArray<readonly [string, () => Promise<ResearchResult<T>>]>,
  isUsable: (data: T) => boolean,
  fact: 'quote' | 'history',
): Promise<ResearchResult<T>> {
  const failedWarnings: ResearchResult<T>['warnings'] = [];
  let last: ResearchResult<T> | undefined;
  for (let index = 0; index < sources.length; index += 1) {
    const [name, call] = sources[index]!;
    const result = await call();
    last = result;
    if (isUsable(result.data)) {
      if (index === 0) return result;
      const unavailable = sources.slice(0, index).map(([source]) => source).join(' and ');
      return {
        ...result,
        warnings: [
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
    failedWarnings.push(...result.warnings);
  }
  return {
    ...last!,
    warnings: failedWarnings,
  };
}

function sourceContext(
  ctx: { signal?: AbortSignal } | undefined,
  timeoutMs: number,
): { signal?: AbortSignal; timeoutMs: number } {
  return { ...(ctx?.signal ? { signal: ctx.signal } : {}), timeoutMs };
}

function hasUsableQuote(quote: Quote): boolean {
  return Number.isFinite(quote.price) && quote.price > 0;
}

function hasUsableHistory(history: PriceBar[]): boolean {
  return history.filter(
    (bar) =>
      Number.isFinite(bar.close) &&
      bar.close > 0 &&
      typeof bar.timestamp === 'string' &&
      !Number.isNaN(Date.parse(bar.timestamp)),
  ).length >= 20;
}

/**
 * A company submissions feed contains both periodic filings and issuer-side
 * Form 3/4/5 disclosures. Keep both categories in the frozen snapshot so the
 * fundamental and governance prompts share the same primary-source set.
 */
async function fetchUsFilings(
  filings: FilingPort,
  instrumentId: string,
  limit: number,
  ctx?: Parameters<FilingPort['searchFilings']>[1],
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
  const citations = [...company.citations, ...insider.citations]
    .filter((citation, index, all) =>
      all.findIndex((item) => item.url === citation.url) === index,
    );
  return {
    schemaVersion: company.schemaVersion,
    data,
    citations,
    freshness: [...company.freshness, ...insider.freshness],
    warnings: [...company.warnings, ...insider.warnings],
  };
}

/**
 * getProfile always returns a `data` object (at minimum the instrument
 * sentinel) even on failure / no-data, so we can't rely on `env.data ?? null`
 * to drive the snapshot's missing/available split. Treat a profile as present
 * only when it carries at least one real descriptive field; otherwise return
 * null so fetchSnapshot records it as `no_data`.
 */
function profileEnvelopeToFact(
  data: CompanyProfile | null | undefined,
): Record<string, unknown> | null {
  if (!data) return null;
  const hasContent =
    Boolean(data.description) ||
    Boolean(data.sector) ||
    Boolean(data.industry) ||
    Boolean(data.website) ||
    typeof data.employees === 'number';
  return hasContent ? (data as unknown as Record<string, unknown>) : null;
}
