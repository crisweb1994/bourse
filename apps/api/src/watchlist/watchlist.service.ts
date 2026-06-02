import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { StockService } from '../stock/stock.service';
import { AddWatchlistDto, UpdateWatchlistDto } from './watchlist.dto';

@Injectable()
export class WatchlistService {
  constructor(
    private prisma: PrismaService,
    private stockService: StockService,
  ) {}

  async list(userId: string) {
    return this.prisma.watchlistItem.findMany({
      where: { userId },
      include: { stock: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  async add(userId: string, dto: AddWatchlistDto) {
    // Upsert the stock first
    const stock = await this.stockService.upsert({
      symbol: dto.symbol,
      name: dto.name,
      market: dto.market,
      exchange: dto.exchange,
      currency: dto.currency,
      yahooSymbol: dto.yahooSymbol,
    });

    // Rely on the @@unique([userId, stockId]) constraint instead of a
    // check-then-act pre-read: one round-trip, no TOCTOU race.
    try {
      return await this.prisma.watchlistItem.create({
        data: {
          userId,
          stockId: stock.id,
          notes: dto.notes,
        },
        include: { stock: true },
      });
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        throw new ConflictException('Stock already in watchlist');
      }
      throw e;
    }
  }

  async update(userId: string, id: string, dto: UpdateWatchlistDto) {
    const item = await this.prisma.watchlistItem.findFirst({
      where: { id, userId },
    });

    if (!item) throw new NotFoundException('Watchlist item not found');

    return this.prisma.watchlistItem.update({
      where: { id },
      data: { notes: dto.notes },
      include: { stock: true },
    });
  }

  async remove(userId: string, id: string) {
    // Ownership-scoped delete in one round-trip — count tells us whether the
    // (id, userId) row existed.
    const { count } = await this.prisma.watchlistItem.deleteMany({
      where: { id, userId },
    });
    if (count === 0) throw new NotFoundException('Watchlist item not found');
    return { ok: true };
  }
}
