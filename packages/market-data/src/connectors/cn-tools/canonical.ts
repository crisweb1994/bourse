import type { ResearchResult } from '../../contracts/result';
import type { ResearchCitation } from '../../contracts/research-citation';
import type { DataFreshness } from '../../contracts/freshness';
import type { ConnectorRunContext } from '../types';
import type {
  OwnershipInput,
  OwnershipObservation,
  ProviderOwnershipPort,
} from '../../ports/ownership';
import type {
  MarketEvent,
  MarketEventsInput,
  ProviderMarketEventsPort,
} from '../../ports/market-events';
import { parseInstrumentId } from '../../util/instrument-id';
import {
  akshareNorthboundCN,
  type AkshareNorthboundInput,
  type AkshareNorthboundOutput,
} from './akshare-northbound';
import { lhbScanCN, type LhbScanInput, type LhbScanOutput } from './lhb-scan';
import { shareholdersCN, type ShareholdersInput, type ShareholdersOutput } from './shareholders';
import { unlockCalendarCN, type UnlockCalendarInput, type UnlockCalendarOutput } from './unlock-calendar';
import type { MarketDataToolDescriptor, MarketDataToolResult } from './types';

interface CnCanonicalTools {
  stockConnect?: MarketDataToolDescriptor<AkshareNorthboundInput, AkshareNorthboundOutput>;
  shareholders?: MarketDataToolDescriptor<ShareholdersInput, ShareholdersOutput>;
  lhb?: MarketDataToolDescriptor<LhbScanInput, LhbScanOutput>;
  unlock?: MarketDataToolDescriptor<UnlockCalendarInput, UnlockCalendarOutput>;
}

export function createCnPublicOwnershipConnector(
  tools: CnCanonicalTools = {},
): ProviderOwnershipPort {
  const stockConnect = tools.stockConnect ?? akshareNorthboundCN;
  const shareholders = tools.shareholders ?? shareholdersCN;
  return {
    async listOwnership(input, ctx) {
      const symbol = cnSymbol(input.instrumentId);
      switch (input.dataSet) {
        case 'stock-connect': {
          const result = await runTool<AkshareNorthboundInput, AkshareNorthboundOutput>(stockConnect, {
            symbol,
            market: 'CN',
            ...(input.limit ? { daysBack: Math.min(input.limit, 60) } : {}),
          }, ctx);
          return researchResult(
            result,
            result.data.rows.flatMap((row): OwnershipObservation[] => {
              const holdingShares = row.holdShares;
              const hasHolding = holdingShares !== null;
              const hasFlow = row.hgt !== 0 || row.sgt !== 0 || !hasHolding;
              const observations: OwnershipObservation[] = [];
              if (hasFlow) {
                observations.push({
                  id: `${input.instrumentId}:stock-connect-flow:${row.date}`,
                  instrumentId: input.instrumentId,
                  kind: 'STOCK_CONNECT',
                  asOf: row.date,
                  shanghaiNetFlow: decimal(row.hgt),
                  shenzhenNetFlow: decimal(row.sgt),
                  flowUnit: 'CNY_100M',
                });
              }
              if (hasHolding) {
                observations.push({
                  id: `${input.instrumentId}:stock-connect-holding:${row.date}`,
                  instrumentId: input.instrumentId,
                  kind: 'STOCK_CONNECT_HOLDING',
                  asOf: row.date,
                  holdingShares: decimal(holdingShares),
                  ...(row.holdPctOfFloat === null
                    ? {}
                    : { holdingPercentOfFloat: decimal(row.holdPctOfFloat) }),
                  ...(row.hgt !== 0 && row.sgt === 0 ? { exchange: 'SH' } : {}),
                  ...(row.sgt !== 0 && row.hgt === 0 ? { exchange: 'SZ' } : {}),
                });
              }
              return observations;
            }),
          );
        }
        case 'shareholder-count': {
          const result = await runTool<ShareholdersInput, ShareholdersOutput>(shareholders, {
            symbol,
            market: 'CN',
            ...(input.limit ? { quartersBack: Math.min(input.limit, 12) } : {}),
          }, ctx);
          return researchResult(
            result,
            result.data.rows.map((row): OwnershipObservation => ({
              id: `${input.instrumentId}:shareholder-count:${row.endDate}`,
              instrumentId: input.instrumentId,
              kind: 'SHAREHOLDER_COUNT',
              asOf: row.endDate,
              holderCount: row.holderTotalNum,
              holderCountChange: row.holderTotalNumChange,
              holderCountChangePercent: nullableDecimal(row.holderTotalNumChangePct),
              averageHoldingAmount: nullableDecimal(row.avgHoldAmount),
              averageHoldingShares: nullableDecimal(row.avgHoldShares),
              concentrationLabel: row.concentrationLabel,
            })),
          );
        }
        default:
          return unsupportedOwnership(input, ctx);
      }
    },
  };
}

export function createCnPublicMarketEventsConnector(
  tools: CnCanonicalTools = {},
): ProviderMarketEventsPort {
  const lhb = tools.lhb ?? lhbScanCN;
  const unlock = tools.unlock ?? unlockCalendarCN;
  return {
    async listEvents(input, ctx) {
      const symbol = cnSymbol(input.instrumentId);
      switch (input.dataSet) {
        case 'lhb': {
          const result = await runTool<LhbScanInput, LhbScanOutput>(lhb, {
            symbol,
            market: 'CN',
            ...(input.limit ? { daysBack: Math.min(input.limit, 90) } : {}),
          }, ctx);
          return researchResult(
            result,
            result.data.appearances.map((row): MarketEvent => ({
              id: `${input.instrumentId}:lhb:${row.date}`,
              instrumentId: input.instrumentId,
              type: 'LHB',
              occurredAt: row.date,
              title: `龙虎榜：${row.reason}`,
              status: 'COMPLETED',
              reason: row.reason,
              reasonCode: row.reasonCode,
              topBuySeatNames: row.topBuySeatNames,
              topSellSeatNames: row.topSellSeatNames,
              buyAmount: nullableDecimal(row.buyAmount),
              sellAmount: nullableDecimal(row.sellAmount),
              netAmount: nullableDecimal(row.netAmount),
            })),
          );
        }
        case 'unlock': {
          const result = await runTool<UnlockCalendarInput, UnlockCalendarOutput>(unlock, {
            symbol,
            market: 'CN',
            ...(input.limit ? { daysAhead: Math.min(input.limit, 365) } : {}),
          }, ctx);
          return researchResult(
            result,
            result.data.events.map((row): MarketEvent => ({
              id: `${input.instrumentId}:unlock:${row.date}:${row.type}`,
              instrumentId: input.instrumentId,
              type: 'UNLOCK',
              occurredAt: row.date,
              effectiveAt: row.date,
              title: `限售解禁：${row.type}`,
              status: 'SCHEDULED',
              shares: decimal(row.shares),
              ...(row.marketValue === undefined
                ? {}
                : { marketValue: decimal(row.marketValue * 100_000_000), currency: 'CNY' }),
              unlockType: row.type,
            })),
          );
        }
        default:
          return unsupportedEvents(input, ctx);
      }
    },
  };
}

async function runTool<TInput, TOutput>(
  tool: MarketDataToolDescriptor<TInput, TOutput>,
  input: TInput,
  ctx?: ConnectorRunContext,
): Promise<MarketDataToolResult<TOutput>> {
  if (!tool.run) throw new Error(`${tool.name} has no run implementation.`);
  return tool.run(input, { ...(ctx?.signal ? { signal: ctx.signal } : {}) });
}

function researchResult<TOutput, TData>(
  result: MarketDataToolResult<TOutput>,
  data: TData,
): ResearchResult<TData> {
  const retrievedAt = latestRetrievedAt(result) ?? new Date().toISOString();
  return {
    schemaVersion: '1.0',
    data,
    citations: result.citations.map((citation): ResearchCitation => ({
      title: citation.title,
      ...(citation.url ? { url: citation.url } : {}),
      sourceType: toSourceType(citation.sourceType),
      provider: result.trace?.source ?? 'cn-public',
      retrievedAt: citation.retrievedAt,
      ...(citation.qualityTier ? { qualityTier: citation.qualityTier } : {}),
    })),
    freshness: [{
      provider: result.trace?.source ?? 'cn-public',
      asOf: freshnessTimestamp(latestAsOf(data) ?? retrievedAt),
      retrievedAt,
      stale: false,
    } satisfies DataFreshness],
    warnings: [],
  };
}

function unsupportedOwnership(
  input: OwnershipInput,
  _ctx?: ConnectorRunContext,
): Promise<ResearchResult<OwnershipObservation[]>> {
  return Promise.resolve(emptyUnsupported(`CN public ownership does not implement ${input.dataSet}.`));
}

function unsupportedEvents(
  input: MarketEventsInput,
  _ctx?: ConnectorRunContext,
): Promise<ResearchResult<MarketEvent[]>> {
  return Promise.resolve(emptyUnsupported(`CN public events does not implement ${input.dataSet}.`));
}

function emptyUnsupported<T>(message: string): ResearchResult<T[]> {
  return {
    schemaVersion: '1.0',
    data: [],
    citations: [],
    freshness: [],
    warnings: [{ code: 'PARTIAL_DATA', message, provider: 'cn-public' }],
  };
}

function cnSymbol(instrumentId: string): string {
  const parsed = parseInstrumentId(instrumentId);
  if (!parsed || parsed.market !== 'CN') {
    throw new Error(`CN canonical connector received unsupported instrument ${instrumentId}.`);
  }
  return parsed.symbol;
}

function decimal(value: number): string {
  if (!Number.isFinite(value)) throw new Error(`Cannot normalize non-finite decimal: ${String(value)}`);
  return String(value);
}

function nullableDecimal(value: number | null): string | null {
  return value === null ? null : decimal(value);
}

function latestRetrievedAt(result: MarketDataToolResult<unknown>): string | undefined {
  return result.citations
    .map((citation) => citation.retrievedAt)
    .filter((value) => Number.isFinite(Date.parse(value)))
    .sort()
    .at(-1);
}

function latestAsOf(data: unknown): string | undefined {
  if (!Array.isArray(data)) return undefined;
  return data
    .flatMap((item) => item && typeof item === 'object' && typeof (item as { asOf?: unknown }).asOf === 'string'
      ? [(item as { asOf: string }).asOf]
      : item && typeof item === 'object' && typeof (item as { occurredAt?: unknown }).occurredAt === 'string'
        ? [(item as { occurredAt: string }).occurredAt]
        : [])
    .sort()
    .at(-1);
}

function freshnessTimestamp(value: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return `${value}T00:00:00.000Z`;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : new Date().toISOString();
}

function toSourceType(value: string): ResearchCitation['sourceType'] {
  switch (value) {
    case 'NEWS':
    case 'FILING':
    case 'SOCIAL':
    case 'WEB':
    case 'PRICE':
    case 'MACRO':
    case 'RESEARCH':
    case 'OTHER':
      return value;
    default:
      return 'OTHER';
  }
}
