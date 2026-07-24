import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { EarningsConsensusService } from './earnings-consensus.service';

const DEFAULT_INTERVAL_MS = 6 * 60 * 60_000;
const CONCURRENCY = 5;

@Injectable()
export class EarningsConsensusScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EarningsConsensusScheduler.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly consensus: EarningsConsensusService,
  ) {}

  onModuleInit(): void {
    if (this.config.get<string>('EARNINGS_CONSENSUS_ENABLED')?.toLowerCase() !== 'true') return;
    void this.tick();
    const configured = Number(this.config.get<string>('EARNINGS_CONSENSUS_INTERVAL_MS'));
    const interval = Number.isFinite(configured)
      ? Math.max(15 * 60_000, configured)
      : DEFAULT_INTERVAL_MS;
    this.timer = setInterval(() => void this.tick(), interval);
    this.logger.log(`财报共识快照已启动（每 ${Math.round(interval / 60_000)}min）`);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const stocks = await this.prisma.stock.findMany({
        where: { market: { in: ['US', 'CN'] }, watchlistItems: { some: {} } },
        orderBy: { id: 'asc' },
      });
      for (let index = 0; index < stocks.length; index += CONCURRENCY) {
        await Promise.allSettled(
          stocks.slice(index, index + CONCURRENCY).map((stock) => this.consensus.capture(stock)),
        );
      }
    } finally {
      this.running = false;
    }
  }
}
