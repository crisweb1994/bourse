import { Injectable, NotFoundException } from '@nestjs/common';
import type { LatestEarningsResponseDto } from '@bourse/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import { EarningsGenerationService } from './earnings-generation.service';
import { toEarningsCardDto, toGenerationRunDto } from './earnings.mapper';

const revisionInclude = {
  card: {
    include: {
      event: { include: { stock: true } },
    },
  },
} as const;

@Injectable()
export class EarningsQueryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly generations: EarningsGenerationService,
  ) {}

  async latest(stockId: string): Promise<LatestEarningsResponseDto> {
    const stock = await this.prisma.stock.findUnique({ where: { id: stockId } });
    if (!stock) throw new NotFoundException('Stock not found');
    const card = await this.prisma.earningsCard.findFirst({
      where: { event: { stockId }, currentRevisionId: { not: null } },
      orderBy: { event: { periodEndOn: 'desc' } },
      include: {
        event: { include: { stock: true } },
        currentRevision: true,
      },
    });
    const generation = await this.prisma.earningsGenerationRun.findFirst({
      where: { stockId, status: { in: ['QUEUED', 'RUNNING'] } },
      orderBy: { createdAt: 'desc' },
    });
    if (!card?.currentRevision) {
      const supported = stock.market === 'US' || stock.market === 'CN' || stock.market === 'HK';
      return {
        available: false,
        supported,
        generation: generation ? toGenerationRunDto(generation) : undefined,
        reason: supported ? undefined : 'MARKET_NOT_YET_SUPPORTED',
      };
    }
    return {
      available: true,
      supported: true,
      card: toEarningsCardDto({
        ...card.currentRevision,
        card: { id: card.id, event: card.event },
      }),
      generation: generation ? toGenerationRunDto(generation) : undefined,
    };
  }

  async generation(userId: string, runId: string) {
    const run = await this.prisma.earningsGenerationRun.findUnique({
      where: { id: runId },
      include: {
        cardRevision: { include: revisionInclude },
      },
    });
    if (!run) throw new NotFoundException('Earnings generation not found');
    await this.generations.assertStockScope(userId, run.stockId);
    return toGenerationRunDto(run);
  }

  async history(stockId: string) {
    const cards = await this.prisma.earningsCard.findMany({
      where: { event: { stockId } },
      orderBy: { event: { periodEndOn: 'desc' } },
      include: {
        event: { include: { stock: true } },
        revisions: { orderBy: { revisionNo: 'desc' }, include: revisionInclude },
      },
    });
    return cards.flatMap((card) => card.revisions.map(toEarningsCardDto));
  }
}
