import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  isAnalysisStatus,
  isAnalysisType,
  type AnalysisStatus,
  type AnalysisType,
} from '@bourse/shared-types';
import { PrismaService } from '../prisma/prisma.service';

export interface AnalysisHistoryOptions {
  page?: number;
  limit?: number;
  analysisType?: string;
  status?: string;
  symbol?: string;
  stockId?: string;
  degradedOnly?: boolean;
}

const MAX_HISTORY_LIMIT = 100;

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
    return analysis;
  }

  /**
   * Lightweight ownership gate for the /stream endpoint. Avoids the full
   * sections+stock load getById does because the runner re-reads the row.
   */
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
      analysisType,
      status,
      symbol,
      stockId,
      degradedOnly,
    } = opts;
    const safePage = normalizePositiveInt(page, 1, 'page');
    const safeLimit = normalizePositiveInt(
      limit,
      20,
      'limit',
      MAX_HISTORY_LIMIT,
    );

    let safeAnalysisType: AnalysisType | undefined;
    if (analysisType) {
      if (!isAnalysisType(analysisType)) {
        throw new BadRequestException('Invalid analysisType');
      }
      safeAnalysisType = analysisType;
    }

    let safeStatus: AnalysisStatus | undefined;
    if (status) {
      if (!isAnalysisStatus(status)) {
        throw new BadRequestException('Invalid status');
      }
      safeStatus = status;
    }

    const skip = (safePage - 1) * safeLimit;

    const where: Record<string, unknown> = { userId };
    if (safeAnalysisType) where.analysisType = safeAnalysisType;
    if (safeStatus) where.status = safeStatus;
    if (symbol) where.symbol = { contains: symbol, mode: 'insensitive' };
    if (stockId) where.stockId = stockId;
    if (degradedOnly) where.degradedSource = 'WEB_SEARCH_FALLBACK';

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

    return { items, total, page: safePage, limit: safeLimit };
  }
}
