import { Injectable } from '@nestjs/common';
import type { FocusWindow as PrismaFocusWindow } from '@prisma/client';
import type {
  FocusWindow,
  HomepageBriefDto,
  HomepageChangeDto,
  StockDto,
} from '@bourse/shared-types';
import { PrismaService } from '../prisma/prisma.service';

const WATCHLIST_LIMIT = 10;
const LIST_LIMIT = 5;
const CHANGE_CANDIDATE_LIMIT = 50;

interface StockRow {
  id: string;
  symbol: string;
  name: string;
  market: string;
  exchange: string;
  currency: string;
  yahooSymbol: string | null;
}

@Injectable()
export class HomepageService {
  constructor(private readonly prisma: PrismaService) {}

  async getBrief(userId: string): Promise<HomepageBriefDto> {
    const watchlistRows = await this.prisma.watchlistItem.findMany({
      where: { userId },
      include: { stock: true },
      orderBy: { createdAt: 'desc' },
      take: WATCHLIST_LIMIT + 1,
    });
    const watchlist = watchlistRows.slice(0, WATCHLIST_LIMIT);

    const [latestResearchRows, recentRows] = await Promise.all([
      Promise.all(
        watchlist.map((item) =>
          this.prisma.analysis.findFirst({
            where: {
              userId,
              stockId: item.stockId,
              status: { in: ['COMPLETED', 'PARTIAL_FAILED'] },
            },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            select: {
              id: true,
              overallSignal: true,
              overallConfidence: true,
              dataAsOf: true,
              completedAt: true,
              evidenceSnapshot: { select: { capturedAt: true } },
            },
          }),
        ),
      ),
      this.prisma.analysis.findMany({
        where: { userId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: LIST_LIMIT,
        include: { stock: true },
      }),
    ]);

    const latestByStock = new Map(
      watchlist.map((item, index) => [item.stockId, latestResearchRows[index] ?? null]),
    );

    const changes = await this.getChanges(watchlist, latestByStock);

    return {
      watchlist: watchlist.map((item) => {
        const latest = latestByStock.get(item.stockId) ?? null;
        return {
          id: item.id,
          stock: toStockDto(item.stock),
          latestResearch: latest
            ? {
                analysisId: latest.id,
                signal: latest.overallSignal,
                confidence: latest.overallConfidence,
                dataAsOf: latest.dataAsOf,
              }
            : null,
        };
      }),
      hasMoreWatchlist: watchlistRows.length > WATCHLIST_LIMIT,
      changes,
      recentAnalyses: recentRows.map((row) => ({
        id: row.id,
        stock: toStockDto(row.stock),
        mode: row.mode,
        focusWindow: toFocusWindow(row.focusWindow),
        status: row.status,
        createdAt: row.createdAt.toISOString(),
      })),
    };
  }

  private async getChanges(
    watchlist: Array<{ stockId: string; createdAt: Date; stock: StockRow }>,
    latestByStock: Map<
      string,
      {
        completedAt: Date | null;
        evidenceSnapshot: { capturedAt: Date } | null;
      } | null
    >,
  ): Promise<HomepageChangeDto[]> {
    if (watchlist.length === 0) return [];

    const baselineByStock = new Map(
      watchlist.map((item) => {
        const latest = latestByStock.get(item.stockId);
        return [
          item.stockId,
          latest?.evidenceSnapshot?.capturedAt ?? latest?.completedAt ?? item.createdAt,
        ];
      }),
    );
    const minBaseline = new Date(
      Math.min(...Array.from(baselineByStock.values(), (date) => date.getTime())),
    );
    const stockIds = watchlist.map((item) => item.stockId);
    const stockById = new Map(watchlist.map((item) => [item.stockId, item.stock]));

    const [filings, cards] = await Promise.all([
      this.prisma.filing.findMany({
        where: {
          stockId: { in: stockIds },
          publishedAt: { gt: minBaseline },
        },
        orderBy: [{ publishedAt: 'desc' }, { id: 'desc' }],
        take: CHANGE_CANDIDATE_LIMIT,
        select: {
          id: true,
          stockId: true,
          formType: true,
          title: true,
          provider: true,
          publishedAt: true,
        },
      }),
      this.prisma.earningsCard.findMany({
        where: {
          event: { stockId: { in: stockIds } },
          currentRevision: { is: { generatedAt: { gt: minBaseline } } },
        },
        orderBy: { currentRevision: { generatedAt: 'desc' } },
        take: CHANGE_CANDIDATE_LIMIT,
        select: {
          id: true,
          event: {
            select: {
              stockId: true,
              periodType: true,
              fiscalYear: true,
              filingLinks: { select: { filingId: true } },
            },
          },
          currentRevision: {
            select: { id: true, revisionNo: true, generatedAt: true },
          },
        },
      }),
    ]);

    const linkedFilingIds = new Set<string>();
    const earningsChanges = cards.flatMap((card): HomepageChangeDto[] => {
      const revision = card.currentRevision;
      const baseline = baselineByStock.get(card.event.stockId);
      const stock = stockById.get(card.event.stockId);
      if (!revision || !baseline || !stock || revision.generatedAt <= baseline) return [];
      card.event.filingLinks.forEach((link) => linkedFilingIds.add(link.filingId));
      const hasResearch = latestByStock.get(card.event.stockId) !== null;
      return [
        {
          id: `earnings:${revision.id}`,
          kind: 'EARNINGS_CARD',
          stock: toStockDto(stock),
          title: `${earningsPeriodLabel(card.event)} 财报卡${revision.revisionNo > 1 ? '已更新' : '已生成'}`,
          detail: `第 ${revision.revisionNo} 版 · ${hasResearch ? '生成于上次研究之后' : '加入自选后生成'}`,
          occurredAt: revision.generatedAt.toISOString(),
        },
      ];
    });

    const filingChanges = filings.flatMap((filing): HomepageChangeDto[] => {
      const baseline = baselineByStock.get(filing.stockId);
      const stock = stockById.get(filing.stockId);
      if (
        !baseline ||
        !stock ||
        filing.publishedAt <= baseline ||
        linkedFilingIds.has(filing.id)
      ) {
        return [];
      }
      const hasResearch = latestByStock.get(filing.stockId) !== null;
      return [
        {
          id: `filing:${filing.id}`,
          kind: 'FILING',
          stock: toStockDto(stock),
          title: filing.title?.trim() || `${filing.formType} 公告已收录`,
          detail: `${filing.formType} · ${filing.provider} · ${hasResearch ? '发布于上次研究之后' : '加入自选后发布'}`,
          occurredAt: filing.publishedAt.toISOString(),
        },
      ];
    });

    return [...earningsChanges, ...filingChanges]
      .sort(
        (left, right) =>
          right.occurredAt.localeCompare(left.occurredAt) || left.id.localeCompare(right.id),
      )
      .slice(0, LIST_LIMIT);
  }
}

function toStockDto(stock: StockRow): StockDto {
  return {
    id: stock.id,
    symbol: stock.symbol,
    name: stock.name,
    market: stock.market as StockDto['market'],
    exchange: stock.exchange,
    currency: stock.currency,
    yahooSymbol: stock.yahooSymbol,
  };
}

function toFocusWindow(value: string): FocusWindow {
  // Keyed by the Prisma FocusWindow enum names; Record makes the mapping
  // exhaustive at compile time so enum drift fails typecheck, not runtime.
  const MAP: Record<PrismaFocusWindow, FocusWindow> = {
    D30: '30D',
    D90: '90D',
    Y1: '1Y',
    Y3: '3Y',
  };
  return (MAP as Record<string, FocusWindow>)[value] ?? '30D';
}

function earningsPeriodLabel(event: {
  fiscalYear: number;
  periodType: string;
}): string {
  const period =
    event.periodType === 'H1'
      ? '半年'
      : event.periodType === 'NINE_M'
        ? '前三季度'
        : event.periodType === 'FY'
          ? '年度'
          : event.periodType;
  return `${event.fiscalYear} ${period}`;
}
