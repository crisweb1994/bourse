import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  defineMarketConfig,
  fetchSnapshot,
  snapshotToEvidencePack,
  STANDARD_RESEARCH_REQUIREMENTS,
  type DataRequirement,
  type MarketConfigMap,
  type StockSnapshot,
  type ToEvidencePackOptions,
  type EvidencePackV2,
} from '@bourse/analysis';
import type {
  ConnectorRunContext,
  ResearchMarketDataClient,
  ResearchResultV2,
  CorporateAction,
  OwnershipObservation,
  MarketEvent,
  CorporateActionDataSet,
  OwnershipDataSet,
  MarketEventDataSet,
  RouteConstraints,
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
        return snapshotEnvelope(result);
      },
      financials: async (symbol: string, ctx?: ConnectorRunContext) => snapshotEnvelope(
        await this.marketData.getFinancials(instrumentId(market, symbol), ctx),
      ),
      filings: async (symbol: string, limit: number, ctx?: ConnectorRunContext) => snapshotEnvelope(
        await this.marketData.listFilings({ instrumentId: instrumentId(market, symbol), limit }, ctx),
      ),
      macro: async (_: string, ctx?: ConnectorRunContext) => snapshotEnvelope(await this.marketData.getMacro(market, ctx)),
    });

    const standard = (market: 'US' | 'CN' | 'HK') => {
      const requirements = STANDARD_RESEARCH_REQUIREMENTS[market];
      const macroRequirements = requirements.filter((item) => item.capability === 'macro' && item.seriesCode);
      const corporateActions = requirementsFor<CorporateActionDataSet>(requirements, 'corporate-actions');
      const ownership = requirementsFor<OwnershipDataSet>(requirements, 'ownership').filter((item) =>
        market !== 'CN' || (item.dataSet !== 'stock-connect' && item.dataSet !== 'shareholder-count'),
      );
      const events = requirementsFor<MarketEventDataSet>(requirements, 'market-events').filter((item) =>
        market !== 'CN' || (item.dataSet !== 'lhb' && item.dataSet !== 'unlock'),
      );
      return {
        ...shared(market),
        requirements,
        ...(macroRequirements.length > 0 ? {
          macro: async (_symbol: string, ctx?: ConnectorRunContext) => snapshotEnvelope(await this.marketData.getMacro({
            market,
            seriesCodes: macroRequirements.map((item) => item.seriesCode!),
          }, ctx, routeConstraints(macroRequirements[0]!))),
        } : {}),
        ...(corporateActions.length > 0 ? {
          corporateActions: async (symbol: string, ctx?: ConnectorRunContext) => mergeListResults(
            await Promise.all(corporateActions.map((requirement) => this.marketData.getCorporateActions({
              instrumentId: instrumentId(market, symbol),
              dataSet: requirement.dataSet,
              limit: 50,
            }, ctx, routeConstraints(requirement)))),
          ),
        } : {}),
        ...(ownership.length > 0 ? {
          ownership: async (symbol: string, ctx?: ConnectorRunContext) => mergeListResults(
            await Promise.all(ownership.map((requirement) => this.marketData.getOwnership({
              instrumentId: instrumentId(market, symbol),
              dataSet: requirement.dataSet,
              limit: 50,
            }, ctx, routeConstraints(requirement)))),
          ),
        } : {}),
        ...(events.length > 0 ? {
          marketEvents: async (symbol: string, ctx?: ConnectorRunContext) => mergeListResults(
            await Promise.all(events.map((requirement) => this.marketData.getMarketEvents({
              instrumentId: instrumentId(market, symbol),
              dataSet: requirement.dataSet,
              limit: 50,
            }, ctx, routeConstraints(requirement)))),
          ),
        } : {}),
      };
    };

    return {
      US: defineMarketConfig('US', 'USD', {
        ...standard('US'),
      }),
      CN: defineMarketConfig('CN', 'CNY', {
        ...standard('CN'),
        consensusEps: async (symbol: string, ctx?: ConnectorRunContext) => snapshotEnvelope(
          await this.marketData.getEarningsConsensus(instrumentId('CN', symbol), ctx),
        ),
        northboundFlow: async (symbol: string, ctx?: ConnectorRunContext) => snapshotEnvelope(
          await this.marketData.getOwnership({
            instrumentId: instrumentId('CN', symbol),
            dataSet: 'stock-connect',
            limit: 20,
          }, ctx),
        ),
        shareholders: async (symbol: string, ctx?: ConnectorRunContext) => snapshotEnvelope(
          await this.marketData.getOwnership({
            instrumentId: instrumentId('CN', symbol),
            dataSet: 'shareholder-count',
            limit: 4,
          }, ctx),
        ),
        lhb: async (symbol: string, ctx?: ConnectorRunContext) => snapshotEnvelope(
          await this.marketData.getMarketEvents({
            instrumentId: instrumentId('CN', symbol),
            dataSet: 'lhb',
            limit: 30,
          }, ctx),
        ),
        unlockCalendar: async (symbol: string, ctx?: ConnectorRunContext) => snapshotEnvelope(
          await this.marketData.getMarketEvents({
            instrumentId: instrumentId('CN', symbol),
            dataSet: 'unlock',
            limit: 90,
          }, ctx),
        ),
      }),
      HK: defineMarketConfig('HK', 'HKD', {
        ...standard('HK'),
      }),
    };
  }
}

function snapshotEnvelope<T>(result: ResearchResultV2<T>) {
  return {
    data: result.data,
    citations: result.citations,
    freshness: result.freshness,
    warnings: result.warnings,
    trace: result.trace,
  };
}

function requirementsFor<TDataSet extends string>(
  requirements: readonly DataRequirement[],
  capability: DataRequirement['capability'],
): Array<DataRequirement & { dataSet: TDataSet }> {
  return requirements.filter((item): item is DataRequirement & { dataSet: TDataSet } =>
    item.capability === capability && typeof item.dataSet === 'string',
  );
}

function routeConstraints(requirement: DataRequirement): RouteConstraints | undefined {
  const constraints: RouteConstraints = {
    ...(requirement.maxAgeMs !== undefined ? { maxAgeMs: requirement.maxAgeMs } : {}),
    ...(requirement.minQualityTier ? { minQualityTier: requirement.minQualityTier } : {}),
    ...(requirement.acceptedDelays ? { acceptedDelays: requirement.acceptedDelays } : {}),
  };
  return Object.keys(constraints).length > 0 ? constraints : undefined;
}

function mergeListResults<T extends CorporateAction | OwnershipObservation | MarketEvent>(
  results: readonly ResearchResultV2<T[]>[],
) {
  const usable = results.filter((result) => result.status === 'ok' || result.status === 'partial');
  const data = usable.flatMap((result) => result.data);
  return {
    data: data.length > 0 ? data : null,
    citations: usable.flatMap((result) => result.citations),
    freshness: usable.flatMap((result) => result.freshness),
    warnings: results.flatMap((result) => result.warnings),
    trace: { attempts: results.flatMap((result) => result.trace.attempts) },
  };
}
