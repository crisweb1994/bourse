import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { isAnalysisStatus, type AnalysisStatus } from '@bourse/shared-types';
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
}
