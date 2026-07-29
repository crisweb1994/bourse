import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  defineMarketConfig,
  fetchSnapshot,
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
  ConnectorRunContext,
  ResearchMarketDataClient,
  ResearchCitation,
  ResearchResultV2,
} from '@bourse/market-data';
import { MARKET_DATA_CLIENT } from '../connectors/connectors.module';

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
    @Inject(MARKET_DATA_CLIENT) private readonly marketData: ResearchMarketDataClient,
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
    const instrumentId = (market: 'US' | 'CN' | 'HK', symbol: string): string =>
      `${market}:${symbol}`;

    const shared = (market: 'US' | 'CN' | 'HK') => ({
      quote: async (symbol: string, ctx?: ConnectorRunContext) => snapshotEnvelope(
        await this.marketData.getQuote(instrumentId(market, symbol), ctx),
      ),
      history: async (symbol: string, from: string, to: string, ctx?: ConnectorRunContext) => snapshotEnvelope(
        await this.marketData.getHistory({
          instrumentId: instrumentId(market, symbol),
          from,
          to,
          interval: '1d',
        }, ctx),
      ),
      profile: async (symbol: string, ctx?: ConnectorRunContext) => {
        const result = await this.marketData.getProfile(instrumentId(market, symbol), ctx);
        return {
          ...snapshotEnvelope(result),
          data: result.data as unknown as Record<string, unknown> | null,
        };
      },
      financials: async (symbol: string, ctx?: ConnectorRunContext) => snapshotEnvelope(
        await this.marketData.getFinancials(instrumentId(market, symbol), ctx),
      ),
      filings: async (symbol: string, limit: number, ctx?: ConnectorRunContext) => snapshotEnvelope(
        await this.marketData.getFilings(instrumentId(market, symbol), limit, ctx),
      ),
      macro: async (_: string, ctx?: ConnectorRunContext) => snapshotEnvelope(await this.marketData.getMacro(market, ctx)),
    });

    return {
      US: defineMarketConfig('US', 'USD', {
        ...shared('US'),
      }),
      CN: defineMarketConfig('CN', 'CNY', {
        ...shared('CN'),
        // CN-only fact tools run through the same snapshot orchestrator;
        // failures surface in dataAvailability with structured reason codes.
        consensusEps: toolToFetcher(consensusEpsCN),
        lhb: toolToFetcher(lhbScanCN),
        northboundFlow: toolToFetcher(akshareNorthboundCN),
        unlockCalendar: toolToFetcher(unlockCalendarCN),
        shareholders: toolToFetcher(shareholdersCN),
      }),
      HK: defineMarketConfig('HK', 'HKD', {
        ...shared('HK'),
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

function snapshotEnvelope<T>(result: ResearchResultV2<T>) {
  return {
    data: result.data,
    citations: result.citations,
    freshness: result.freshness,
    warnings: result.warnings,
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
