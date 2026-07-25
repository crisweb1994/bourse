import { Injectable, NotFoundException } from '@nestjs/common';
import type { InvestorRelationsTimelineResponseDto } from '@bourse/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import { InvestorRelationsGenerationService } from './investor-relations-generation.service';
import { toInvestorRelationsEventDto, toInvestorRelationsGenerationRunDto } from './investor-relations.mapper';

const revisionInclude = { event: { include: { stock: true } } } as const;

@Injectable()
export class InvestorRelationsQueryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly generations: InvestorRelationsGenerationService,
  ) {}

  async timeline(stockId: string, cursor?: string, requestedLimit = 20): Promise<InvestorRelationsTimelineResponseDto> {
    const stock = await this.prisma.stock.findUnique({ where: { id: stockId } });
    if (!stock) throw new NotFoundException('Stock not found');
    if (stock.market !== 'CN') return { supported: false, events: [], reason: 'MARKET_NOT_SUPPORTED' };
    const limit = Math.min(Math.max(requestedLimit || 20, 1), 50);
    const decoded = decodeCursor(cursor);
    const events = await this.prisma.investorRelationsEvent.findMany({
      where: {
        stockId,
        currentRevisionId: { not: null },
        ...(decoded ? { OR: [{ occurredAt: { lt: decoded.occurredAt } }, { occurredAt: decoded.occurredAt, id: { lt: decoded.id } }] } : {}),
      },
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      include: { currentRevision: { include: revisionInclude } },
    });
    const generation = await this.prisma.investorRelationsGenerationRun.findFirst({ where: { stockId, status: { in: ['QUEUED', 'RUNNING'] } }, orderBy: { createdAt: 'desc' } });
    const page = events.slice(0, limit);
    const last = page.at(-1);
    return {
      supported: true,
      events: page.flatMap((event) => event.currentRevision ? [toInvestorRelationsEventDto(event.currentRevision)] : []),
      generation: generation ? toInvestorRelationsGenerationRunDto(generation) : undefined,
      nextCursor: events.length > limit && last ? encodeCursor(last.occurredAt, last.id) : undefined,
    };
  }

  async detail(eventId: string, expectedStockId?: string) {
    const event = await this.prisma.investorRelationsEvent.findFirst({
      where: { id: eventId, ...(expectedStockId ? { stockId: expectedStockId } : {}) },
      include: { currentRevision: { include: revisionInclude } },
    });
    if (!event?.currentRevision) throw new NotFoundException('Investor relations event not found');
    return toInvestorRelationsEventDto(event.currentRevision);
  }

  async generation(userId: string, runId: string) {
    const run = await this.prisma.investorRelationsGenerationRun.findUnique({ where: { id: runId }, include: { revision: { include: revisionInclude } } });
    if (!run) throw new NotFoundException('Investor relations generation not found');
    await this.generations.assertStockScope(userId, run.stockId);
    return toInvestorRelationsGenerationRunDto(run);
  }
}

function encodeCursor(occurredAt: Date, id: string): string {
  return Buffer.from(JSON.stringify([occurredAt.toISOString(), id])).toString('base64url');
}

function decodeCursor(value?: string): { occurredAt: Date; id: string } | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== 2 || typeof parsed[0] !== 'string' || typeof parsed[1] !== 'string') return null;
    const occurredAt = new Date(parsed[0]);
    return Number.isNaN(occurredAt.getTime()) ? null : { occurredAt, id: parsed[1] };
  } catch {
    return null;
  }
}
