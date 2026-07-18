import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { StockService } from '../stock/stock.service';
import { CreateThreadDto, UpdateThreadDto } from './chat.dto';

@Injectable()
export class ThreadService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stocks: StockService,
  ) {}

  async create(userId: string, symbol: string, market: string | undefined, dto: CreateThreadDto = {}) {
    const normalized = (symbol ?? '').trim().toUpperCase();
    let stock = await this.prisma.stock.findFirst({
      where: {
        OR: [
          ...(market ? [{ symbol: normalized, market: market.toUpperCase() as any }] : []),
          { symbol: normalized },
          { yahooSymbol: normalized },
        ],
      },
    });
    if (!stock) {
      const candidates = await this.stocks.search(normalized);
      const exact = candidates.find((candidate) => {
        const symbols = [candidate.symbol, candidate.yahooSymbol]
          .filter(Boolean)
          .map((value) => value!.toUpperCase());
        return symbols.includes(normalized)
          && (!market || candidate.market.toUpperCase() === market.toUpperCase());
      });
      if (exact && ['US', 'CN', 'HK'].includes(exact.market.toUpperCase())) {
        stock = await this.stocks.upsert({
          symbol: exact.symbol,
          name: exact.name,
          market: exact.market,
          exchange: exact.exchange,
          currency: exact.currency,
          yahooSymbol: exact.yahooSymbol,
        });
      }
    }
    if (!stock) throw new NotFoundException('Stock not found');
    return this.prisma.researchThread.create({
      data: {
        userId,
        primaryStockId: stock.id,
        title: dto.title?.trim() || `${stock.name} 研究`,
      },
      include: { primaryStock: true },
    });
  }

  async list(userId: string, symbol: string, includeArchived = false) {
    const stock = await this.resolveStock(symbol);
    if (!stock) return [];
    return this.prisma.researchThread.findMany({
      where: {
        userId,
        primaryStockId: stock.id,
        ...(includeArchived ? {} : { archivedAt: null }),
      },
      include: {
        primaryStock: true,
        messages: { orderBy: { sequence: 'desc' }, take: 1 },
        generations: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: {
            id: true,
            intent: true,
            status: true,
            createdAt: true,
            completedAt: true,
          },
        },
      },
      orderBy: { updatedAt: 'desc' },
    });
  }

  async listRecent(userId: string, includeArchived = false) {
    return this.prisma.researchThread.findMany({
      where: {
        userId,
        ...(includeArchived ? {} : { archivedAt: null }),
      },
      include: {
        primaryStock: true,
        messages: { orderBy: { sequence: 'desc' }, take: 1 },
        generations: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: {
            id: true,
            intent: true,
            status: true,
            createdAt: true,
            completedAt: true,
          },
        },
      },
      orderBy: { updatedAt: 'desc' },
      take: 30,
    });
  }

  async get(userId: string, threadId: string) {
    const thread = await this.prisma.researchThread.findFirst({
      where: { id: threadId, userId },
      include: {
        primaryStock: true,
        messages: { orderBy: { sequence: 'asc' } },
        generations: {
          orderBy: { createdAt: 'desc' },
          take: 20,
          select: {
            id: true,
            threadId: true,
            clientRequestId: true,
            intent: true,
            status: true,
            createdAt: true,
            completedAt: true,
            groundedSources: true,
            openResearchSnapshot: {
              select: {
                id: true,
                dataAsOf: true,
                gatewayVersion: true,
                sources: true,
              },
            },
          },
        },
      },
    });
    if (!thread) throw new NotFoundException('Research thread not found');
    return thread;
  }

  async update(userId: string, threadId: string, dto: UpdateThreadDto) {
    await this.assertOwned(userId, threadId);
    return this.prisma.researchThread.update({
      where: { id: threadId },
      data: {
        ...(dto.title !== undefined ? { title: dto.title.trim() || '未命名研究' } : {}),
        ...(dto.action === 'archive' ? { archivedAt: new Date() } : {}),
        ...(dto.action === 'restore' ? { archivedAt: null } : {}),
      },
      include: { primaryStock: true },
    });
  }

  async remove(userId: string, threadId: string) {
    await this.assertOwned(userId, threadId);
    const activeGenerations = await this.prisma.chatGeneration.count({
      where: { threadId, status: { in: ['PENDING', 'RUNNING'] as any } },
    });
    if (activeGenerations > 0) {
      throw new ConflictException('Cannot delete a thread while an answer is running');
    }
    await this.prisma.researchThread.delete({ where: { id: threadId } });
    return { ok: true };
  }

  async assertOwned(userId: string, threadId: string) {
    const row = await this.prisma.researchThread.findFirst({
      where: { id: threadId, userId },
      select: { id: true, primaryStockId: true },
    });
    if (!row) throw new NotFoundException('Research thread not found');
    return row;
  }

  private async resolveStock(symbol: string) {
    const normalized = (symbol ?? '').trim().toUpperCase();
    if (!normalized) return null;
    return this.prisma.stock.findFirst({
      where: { OR: [{ symbol: normalized }, { yahooSymbol: normalized }] },
    });
  }
}
