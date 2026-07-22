import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { EarningsConsensusService } from './earnings-consensus.service';
import { parsePositiveInteger } from './filing-detection.scheduler';

const LOCK_KEY = 'bourse:earnings:consensus-snapshot';
const LEASE_KEY = 'consensus-snapshot';
const DEFAULT_INTERVAL_MS = 6 * 60 * 60_000;
const LEASE_MS = 30 * 60_000;

@Injectable()
export class EarningsConsensusScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EarningsConsensusScheduler.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly concurrency: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly consensus: EarningsConsensusService,
  ) {
    this.concurrency = parsePositiveInteger(
      this.config.get<string>('EARNINGS_CONSENSUS_CONCURRENCY'),
      5,
      1,
      32,
      'EARNINGS_CONSENSUS_CONCURRENCY',
    );
  }

  onModuleInit(): void {
    if (this.config.get<string>('EARNINGS_CONSENSUS_ENABLED')?.toLowerCase() !== 'true') return;
    void this.tick();
    const configured = Number(this.config.get<string>('EARNINGS_CONSENSUS_INTERVAL_MS') ?? DEFAULT_INTERVAL_MS);
    const interval = Number.isFinite(configured) ? Math.max(15 * 60_000, configured) : DEFAULT_INTERVAL_MS;
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
    const ownerToken = randomUUID();
    try {
      if (!await this.claim(ownerToken)) return;
      const stocks = await this.prisma.stock.findMany({
        where: { market: { in: ['US', 'CN'] }, watchlistItems: { some: {} } },
        orderBy: { id: 'asc' },
      });
      for (let index = 0; index < stocks.length; index += this.concurrency) {
        const batch = stocks.slice(index, index + this.concurrency);
        await Promise.allSettled(batch.map((stock) => this.consensus.capture(stock)));
        if (!await this.renew(ownerToken)) {
          this.logger.warn('共识快照租约已丢失，停止剩余批次');
          return;
        }
      }
    } finally {
      await this.release(ownerToken).catch(() => undefined);
      this.running = false;
    }
  }

  private claim(ownerToken: string): Promise<boolean> {
    const now = new Date();
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${LOCK_KEY}))`;
      const current = await tx.earningsSchedulerLease.findUnique({ where: { key: LEASE_KEY } });
      if (current && current.leaseUntil > now) return false;
      await tx.earningsSchedulerLease.upsert({
        where: { key: LEASE_KEY },
        update: { ownerToken, leaseUntil: new Date(now.getTime() + LEASE_MS) },
        create: { key: LEASE_KEY, ownerToken, leaseUntil: new Date(now.getTime() + LEASE_MS) },
      });
      return true;
    });
  }

  private async renew(ownerToken: string): Promise<boolean> {
    const renewed = await this.prisma.earningsSchedulerLease.updateMany({
      where: { key: LEASE_KEY, ownerToken },
      data: { leaseUntil: new Date(Date.now() + LEASE_MS) },
    });
    return renewed.count === 1;
  }

  private async release(ownerToken: string): Promise<void> {
    await this.prisma.earningsSchedulerLease.updateMany({
      where: { key: LEASE_KEY, ownerToken },
      data: { ownerToken: null, leaseUntil: new Date(0) },
    });
  }
}
