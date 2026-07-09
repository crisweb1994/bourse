import { Injectable, NotFoundException } from '@nestjs/common';
import { SCHEMA_VERSION } from '@bourse/analysis';
import { ProviderResolverService } from './provider-resolver.service';
import { PrismaService } from '../prisma/prisma.service';
import { CreateAnalysisDto } from './analysis.dto';
import type { SseCallback } from './types';

// Re-export so existing imports from `./analysis.service` keep working
// during the split (adapter, scenario-runner). New code should import from
// `./types` directly.
export type { SseCallback };

// Canonical comprehensive-workflow order. Plan 3 §3.1: GOVERNANCE follows
// FUNDAMENTAL so governance research builds on the financial picture.
// Order MUST match packages/agent/src/dimensions/index.ts:ALL_DIMENSIONS.
const ALL_SECTION_TYPES = [
  'FUNDAMENTAL', 'GOVERNANCE', 'VALUATION', 'INDUSTRY', 'RISK',
  'TECHNICAL', 'SENTIMENT', 'SCENARIO', 'PORTFOLIO',
] as const;

@Injectable()
export class AnalysisService {
  constructor(
    private prisma: PrismaService,
    private providerResolver: ProviderResolverService,
  ) {}

  async create(userId: string, dto: CreateAnalysisDto) {
    return this.createAnalysisRecord(userId, dto);
  }

  private async createAnalysisRecord(userId: string, dto: CreateAnalysisDto) {
    const stock = await this.prisma.stock.findUnique({
      where: { id: dto.stockId },
    });
    if (!stock) throw new NotFoundException('Stock not found');

    const isComprehensive = dto.analysisType === 'COMPREHENSIVE';
    const { aiModel, providerName, settingId } = await this.providerResolver.resolveProvider(userId, {
      settingIdHint: dto.aiProviderSettingId,
      providerNameHint: dto.aiProvider,
      modelHint: dto.aiModel,
    });

    const sections = isComprehensive
      ? ALL_SECTION_TYPES.map((type, i) => ({ type: type as any, order: i }))
      : [{ type: dto.analysisType as any, order: 0 }];

    const analysis = await this.prisma.analysis.create({
      data: {
        userId,
        stockId: stock.id,
        symbol: stock.symbol,
        market: stock.market,
        analysisType: dto.analysisType as any,
        aiProvider: providerName,
        aiModel,
        aiProviderSettingId: settingId,
        promptVersion: SCHEMA_VERSION,
        sections: { create: sections },
      },
      include: { sections: { orderBy: { order: 'asc' } }, stock: true },
    });

    return analysis;
  }

  async getById(userId: string, id: string) {
    const analysis = await this.prisma.analysis.findFirst({
      where: { id, userId },
      include: {
        sections: { orderBy: { order: 'asc' } },
        stock: true,
      },
    });
    if (!analysis) throw new NotFoundException('Analysis not found');
    return analysis;
  }

  /**
   * Lightweight ownership gate for the /stream endpoint. Avoids the full
   * sections+stock load getById does — runAnalysis re-reads the whole row
   * anyway, and the SSE client reconnects every ~3s, so the heavy read was
   * paid twice per connect.
   */
  async assertOwnership(userId: string, id: string): Promise<void> {
    const row = await this.prisma.analysis.findFirst({
      where: { id, userId },
      select: { id: true },
    });
    if (!row) throw new NotFoundException('Analysis not found');
  }

  async getHistory(
    userId: string,
    opts: {
      page?: number;
      limit?: number;
      analysisType?: string;
      status?: string;
      symbol?: string;
      stockId?: string;
      /** RFC rfc-evidence-pack-web-search-fallback: filter to runs whose
       *  EvidencePack came from v1 web_search fallback. */
      degradedOnly?: boolean;
    } = {},
  ) {
    const {
      page = 1,
      limit = 20,
      analysisType,
      status,
      symbol,
      stockId,
      degradedOnly,
    } = opts;
    const skip = (page - 1) * limit;

    const where: any = { userId };
    if (analysisType) where.analysisType = analysisType;
    if (status) where.status = status;
    if (symbol) where.symbol = { contains: symbol, mode: 'insensitive' };
    if (stockId) where.stockId = stockId;
    if (degradedOnly) where.degradedSource = 'WEB_SEARCH_FALLBACK';

    const [items, total] = await Promise.all([
      this.prisma.analysis.findMany({
        where,
        include: { stock: true, sections: { select: { type: true, status: true } } },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.analysis.count({ where }),
    ]);
    const itemsWithResearch = items.map((it) => {
      return {
        ...it,
        snapshotIds: [] as string[],
        research: {
          researchMode: 'legacy' as const,
          degradedReasons: [] as string[],
        },
      };
    });
    return { items: itemsWithResearch, total, page, limit };
  }

  async delete(userId: string, id: string) {
    const analysis = await this.prisma.analysis.findFirst({
      where: { id, userId },
    });
    if (!analysis) throw new NotFoundException('Analysis not found');

    await this.prisma.analysis.delete({ where: { id } });
    return { ok: true };
  }
}

