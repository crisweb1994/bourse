import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  ChartEvidenceResponseSchema,
  ChartPriceSeriesSchema,
  isAnalysisStatus,
  isTerminalAnalysisStatus,
  type AnalysisStatus,
  type ChartEvidenceResponse,
} from '@bourse/shared-types';
import { PrismaService } from '../prisma/prisma.service';

export interface AnalysisHistoryOptions {
  page?: number;
  limit?: number;
  mode?: string;
  status?: string;
  symbol?: string;
  stockId?: string;
}

const MAX_HISTORY_LIMIT = 100;
const MODES = new Set(['QUICK', 'DEEP']);

interface FactShape {
  value?: unknown;
  asOf?: unknown;
  sourceTier?: unknown;
}

interface PackPayload {
  facts?: Record<string, FactShape | undefined>;
  computedFacts?: {
    technical?: unknown;
    ratios?: { periodTrends?: unknown } | null;
    valuation?: unknown;
    peerComparison?: unknown;
  } | null;
  priceSeries?: ChartEvidenceResponse['chartFacts']['priceSeries'];
  researchCoverage?: unknown;
  dataAvailability?: {
    complete?: unknown;
    missing?: Array<{ field?: unknown; reason?: unknown }>;
    fallbacks?: unknown;
  };
}



export function mapFocusWindow(value: string): string {
  return ({ D30: '30D', D90: '90D', Y1: '1Y', Y3: '3Y' } as Record<string, string>)[value] ?? value;
}

/** Keep Prisma's storage names out of the public API contract. */
export function mapAnalysisDto<T extends Record<string, any>>(row: T): T {
  return {
    ...row,
    focusWindow: mapFocusWindow(String(row.focusWindow)),
    sections: Array.isArray(row.sections)
      ? row.sections.map((section: Record<string, any>) => ({
          ...section,
          status: String(section.status),
          type: String(section.type),
        }))
      : row.sections,
  } as T;
}

function normalizePositiveInt(
  value: number | undefined,
  fallback: number,
  field: string,
  max?: number,
): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1) {
    throw new BadRequestException(`${field} must be a positive integer`);
  }
  if (max !== undefined && value > max) {
    throw new BadRequestException(`${field} must be <= ${max}`);
  }
  return value;
}

@Injectable()
export class AnalysisQueryService {
  constructor(private readonly prisma: PrismaService) {}

  async getById(userId: string, id: string) {
    const analysis = await this.prisma.analysis.findFirst({
      where: { id, userId },
      include: {
        sections: { orderBy: { order: 'asc' } },
        stock: true,
      },
    });
    if (!analysis) throw new NotFoundException('Analysis not found');
    return mapAnalysisDto(analysis);
  }

  async assertOwnership(userId: string, id: string): Promise<void> {
    const row = await this.prisma.analysis.findFirst({
      where: { id, userId },
      select: { id: true },
    });
    if (!row) throw new NotFoundException('Analysis not found');
  }

  async getHistory(userId: string, opts: AnalysisHistoryOptions = {}) {
    const {
      page = 1,
      limit = 20,
      mode,
      status,
      symbol,
      stockId,
    } = opts;
    const safePage = normalizePositiveInt(page, 1, 'page');
    const safeLimit = normalizePositiveInt(limit, 20, 'limit', MAX_HISTORY_LIMIT);

    if (mode && !MODES.has(mode)) throw new BadRequestException('Invalid mode');
    let safeStatus: AnalysisStatus | undefined;
    if (status) {
      if (!isAnalysisStatus(status)) throw new BadRequestException('Invalid status');
      safeStatus = status;
    }

    const skip = (safePage - 1) * safeLimit;
    const where: Record<string, unknown> = { userId };
    if (mode) where.mode = mode;
    if (safeStatus) where.status = safeStatus;
    if (symbol) where.symbol = { contains: symbol, mode: 'insensitive' };
    if (stockId) where.stockId = stockId;

    const [items, total] = await Promise.all([
      this.prisma.analysis.findMany({
        where,
        include: {
          stock: true,
          sections: { select: { type: true, status: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: safeLimit,
      }),
      this.prisma.analysis.count({ where }),
    ]);

    return {
      items: items.map((item) => mapAnalysisDto(item)),
      total,
      page: safePage,
      limit: safeLimit,
    };
  }
  /**
   * Chart evidence projection (visualization technical design §五⑥).
   * Narrow read-only projection of the persisted evidence snapshot payload —
   * webDocuments/citations never leave the endpoint. `available:false` with a
   * stable reason lets the client distinguish "no snapshot" from transport
   * errors (design P6/R-6) instead of hanging in a loading state.
   *
   * F11 honesty rule: the DTO top level carries only capturedAt (fetch time);
   * per-block data dates come from each block's own asOf/computedAt fields.
   */
  async getChartEvidence(userId: string, id: string): Promise<ChartEvidenceResponse> {
    const row = await this.prisma.analysis.findFirst({
      where: { id, userId },
      select: {
        status: true,
        evidenceSnapshot: {
          select: { capturedAt: true, degraded: true, payload: true },
        },
      },
    });
    if (!row) throw new NotFoundException('Analysis not found');

    const unavailable = (reason: 'no_snapshot' | 'not_terminal'): ChartEvidenceResponse => ({
      available: false,
      reason,
      capturedAt: new Date().toISOString(),
      degraded: false,
      dataAvailability: { complete: [], missing: [], fallbacks: [] },
      chartFacts: {
        quote: null,
        priceSeries: null,
        technical: null,
        ratios: null,
        valuation: null,
        peerComparison: null,
        northbound: null,
        northboundHoldings: null,
        unlockCalendar: null,
        corporateActions: null,
      },
      provenance: {},
    });
    const snapshot = row.evidenceSnapshot;
    if (!snapshot) {
      const status = typeof row.status === 'string' ? row.status : undefined;
      return ChartEvidenceResponseSchema.parse(
        unavailable(status && !isTerminalAnalysisStatus(status) ? 'not_terminal' : 'no_snapshot'),
      );
    }

    const pack = snapshot.payload as PackPayload | null;
    if (!pack || typeof pack !== 'object') {
      return ChartEvidenceResponseSchema.parse(unavailable('no_snapshot'));
    }

    const facts = (pack.facts ?? {}) as Record<string, FactShape | undefined>;
    const computed = pack.computedFacts;
    const quoteFact = facts.quote;
    const currencyFact = facts.currency;
    const peFact = facts.pe;
    const parsedPriceSeries = ChartPriceSeriesSchema.safeParse(pack.priceSeries);
    const priceSeries = parsedPriceSeries.success ? parsedPriceSeries.data : null;
    const availability = pack.dataAvailability;
    const legacyNorthbound = Array.isArray(facts.northboundFlow?.value)
      ? facts.northboundFlow.value
      : [];
    const northboundFlow = projectNorthboundFlow(legacyNorthbound);
    const northboundHoldings = [
      ...(Array.isArray(facts.northboundHoldings?.value) ? facts.northboundHoldings.value : []),
      ...projectLegacyNorthboundHoldings(legacyNorthbound),
    ];

    const capturedAt =
      snapshot.capturedAt instanceof Date
        ? snapshot.capturedAt.toISOString()
        : String(snapshot.capturedAt);

    const response: ChartEvidenceResponse = {
      available: true,
      capturedAt,
      degraded: snapshot.degraded,
      dataAvailability: {
        complete: Array.isArray(availability?.complete)
          ? availability.complete.map(String)
          : [],
        missing: Array.isArray(availability?.missing)
          ? availability.missing.map((m) => ({
              field: String(m?.field ?? ''),
              reason: String(m?.reason ?? ''),
            }))
          : [],
        fallbacks: Array.isArray(availability?.fallbacks)
          ? availability.fallbacks.map((f) =>
              typeof f === 'string'
                ? f
                : String((f as { field?: unknown })?.field ?? JSON.stringify(f)),
            )
          : [],
      },
      researchCoverage: pack.researchCoverage ?? null,
      chartFacts: {
        quote:
          quoteFact && typeof quoteFact.value === 'number' && Number.isFinite(quoteFact.value)
            ? {
                price: quoteFact.value,
                changePct: null,
                currency:
                  currencyFact && typeof currencyFact.value === 'string'
                    ? currencyFact.value
                    : null,
                asOf: typeof quoteFact.asOf === 'string' ? quoteFact.asOf : null,
                pe:
                  peFact && typeof peFact.value === 'number' && Number.isFinite(peFact.value)
                    ? peFact.value
                    : null,
              }
            : null,
        priceSeries,
        technical: computed?.technical ?? null,
        ratios:
          computed?.ratios && Array.isArray(computed.ratios.periodTrends)
            ? { periodTrends: computed.ratios.periodTrends }
            : null,
        valuation: computed?.valuation ?? null,
        peerComparison: computed?.peerComparison ?? null,
        northbound: northboundFlow.length > 0 ? northboundFlow : null,
        northboundHoldings: northboundHoldings.length > 0 ? northboundHoldings : null,
        unlockCalendar: facts.unlockCalendar?.value ?? null,
        corporateActions: facts.corporateActions?.value ?? null,
      },
      provenance: {
        ...(sourceTierOf(quoteFact?.sourceTier) ? { quote: sourceTierOf(quoteFact?.sourceTier) } : {}),
        ...(sourceTierOf(facts.financials?.sourceTier) ? { financials: sourceTierOf(facts.financials?.sourceTier) } : {}),
        ...(priceSeries
          ? { history: priceSeries.sourceTier }
          : {}),
        ...(sourceTierOf(facts.northboundHoldings?.sourceTier ?? facts.northboundFlow?.sourceTier)
          ? { northbound: sourceTierOf(facts.northboundHoldings?.sourceTier ?? facts.northboundFlow?.sourceTier) }
          : {}),
        ...(sourceTierOf(facts.unlockCalendar?.sourceTier)
          ? { unlockCalendar: sourceTierOf(facts.unlockCalendar?.sourceTier) }
          : {}),
        ...(sourceTierOf(facts.corporateActions?.sourceTier)
          ? { corporateActions: sourceTierOf(facts.corporateActions?.sourceTier) }
          : {}),
      },
    };
    return ChartEvidenceResponseSchema.parse(response);
  }
}

function sourceTierOf(value: unknown): 'A' | 'B' | 'C' | 'D' | 'E' | undefined {
  return value === 'A' || value === 'B' || value === 'C' || value === 'D' || value === 'E'
    ? value
    : undefined;
}

function projectNorthboundFlow(value: unknown): Array<{ date: string; hgt: number; sgt: number }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const row = item as Record<string, unknown>;
    const date = typeof row.date === 'string' ? row.date : null;
    const hgt = typeof row.hgt === 'number' && Number.isFinite(row.hgt) ? row.hgt : null;
    const sgt = typeof row.sgt === 'number' && Number.isFinite(row.sgt) ? row.sgt : null;
    const hasHolding = Number.isFinite(Number(row.holdingShares ?? row.holdShares));
    // Legacy snapshots mixed holding fields into flow rows. A zero/zero row
    // with holdings is a holding snapshot, not a zero-flow observation.
    return date && hgt !== null && sgt !== null && (hgt !== 0 || sgt !== 0 || !hasHolding)
      ? [{ date, hgt, sgt }]
      : [];
  });
}

function projectLegacyNorthboundHoldings(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const row = item as Record<string, unknown>;
    const date = typeof row.date === 'string' ? row.date : null;
    const holdingShares = Number(row.holdingShares ?? row.holdShares);
    if (!date || !Number.isFinite(holdingShares)) return [];
    const pctRaw = row.holdingPercentOfFloat ?? row.holdPctOfFloat;
    const pct = Number(pctRaw);
    const marketValue = Number(row.holdingMarketValue ?? row.holdMarketValue);
    return [{
      date,
      holdingShares,
      ...(Number.isFinite(pct) ? { holdingPercentOfFloat: pct } : {}),
      ...(Number.isFinite(marketValue) ? { holdingMarketValue: marketValue } : {}),
    }];
  });
}
