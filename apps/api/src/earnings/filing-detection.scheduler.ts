import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { EarningsGenerationService } from './earnings-generation.service';
import { EarningsConsensusService } from './earnings-consensus.service';

const DETECTION_LOCK_KEY = 'bourse:earnings:filing-detection';
const LEASE_MS = 8 * 60_000;
const MAX_BACKOFF_MS = 6 * 60 * 60_000;

@Injectable()
export class FilingDetectionScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(FilingDetectionScheduler.name);
  private timer: NodeJS.Timeout | null = null;
  private readonly intervalMs: number;
  private readonly batchSize: number;
  private readonly concurrency: number;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly generations: EarningsGenerationService,
    private readonly consensus: EarningsConsensusService,
  ) {
    this.intervalMs = parsePositiveInteger(
      this.config.get<string>('EARNINGS_DETECTION_INTERVAL_MS'),
      300_000,
      60_000,
      600_000,
      'EARNINGS_DETECTION_INTERVAL_MS',
    );
    this.batchSize = parsePositiveInteger(
      this.config.get<string>('EARNINGS_DETECTION_BATCH_SIZE'),
      50,
      1,
      1_000,
      'EARNINGS_DETECTION_BATCH_SIZE',
    );
    this.concurrency = parsePositiveInteger(
      this.config.get<string>('EARNINGS_DETECTION_CONCURRENCY'),
      5,
      1,
      32,
      'EARNINGS_DETECTION_CONCURRENCY',
    );
  }

  onModuleInit(): void {
    if (this.config.get<string>('EARNINGS_DETECTION_ENABLED')?.toLowerCase() !== 'true') return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.logger.log(`财报检测已启动（每 ${this.intervalMs / 60_000}min，独立于 Digest）`);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    if (this.running) {
      this.logger.warn('上一次财报检测尚未完成，跳过本次 tick');
      return;
    }
    this.running = true;
    try {
      const watchlistStockIds = await this.syncWatchlistCursors();
      let remaining = this.batchSize;
      while (remaining > 0) {
        const claims = await this.claimBatch(
          watchlistStockIds,
          Math.min(this.concurrency, remaining),
        );
        if (claims.length === 0) break;
        await Promise.all(claims.map((claim) => this.scanOne(claim.stockId)));
        remaining -= claims.length;
      }
    } finally {
      this.running = false;
    }
  }

  private async syncWatchlistCursors(): Promise<string[]> {
    const now = new Date();
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${DETECTION_LOCK_KEY}))`;
      const watchlist = await tx.watchlistItem.findMany({
        where: { stock: { market: { in: ['US', 'CN'] } } },
        distinct: ['stockId'],
        select: { stockId: true },
      });
      for (const row of watchlist) {
        await tx.filingDetectionCursor.upsert({
          where: { stockId: row.stockId },
          update: {},
          create: { stockId: row.stockId, nextCheckAt: now },
        });
      }
      return watchlist.map((row) => row.stockId);
    });
  }

  private async claimBatch(
    watchlistStockIds: string[],
    take: number,
  ): Promise<Array<{ stockId: string }>> {
    if (watchlistStockIds.length === 0 || take === 0) return [];
    const now = new Date();
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${DETECTION_LOCK_KEY}))`;
      const candidates = await tx.filingDetectionCursor.findMany({
        where: {
          stockId: { in: watchlistStockIds },
          nextCheckAt: { lte: now },
          OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }],
        },
        orderBy: { nextCheckAt: 'asc' },
        take,
        select: { stockId: true },
      });
      const leaseUntil = new Date(now.getTime() + LEASE_MS);
      const claimed: Array<{ stockId: string }> = [];
      for (const candidate of candidates) {
        const result = await tx.filingDetectionCursor.updateMany({
          where: {
            stockId: candidate.stockId,
            nextCheckAt: { lte: now },
            OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }],
          },
          data: { leaseUntil },
        });
        if (result.count === 1) claimed.push(candidate);
      }
      return claimed;
    });
  }

  private async scanOne(stockId: string): Promise<void> {
    const startedAt = Date.now();
    try {
      const stock = await this.prisma.stock.findUnique({ where: { id: stockId } });
      if (stock) await this.consensus.capture(stock).catch(() => 0);
      const run = await this.generations.createDetected(stockId);
      const descriptor = run?.sourceDescriptor;
      await this.prisma.filingDetectionCursor.update({
        where: { stockId },
        data: {
          leaseUntil: null,
          lastCheckedAt: new Date(),
          nextCheckAt: new Date(Date.now() + this.intervalMs),
          failureCount: 0,
          lastError: null,
          ...(run ? {
            lastDiscoveredAt: run.createdAt,
            lastSourceDocumentId: descriptor && typeof descriptor === 'object' && !Array.isArray(descriptor)
              ? typeof (descriptor as Record<string, unknown>).sourceDocumentId === 'string'
                ? (descriptor as Record<string, string>).sourceDocumentId
                : undefined
              : undefined,
          } : {}),
        },
      });
      this.logger.debug(`检测 ${stockId} 完成，${Date.now() - startedAt}ms`);
    } catch (error) {
      const current = await this.prisma.filingDetectionCursor.findUnique({ where: { stockId } });
      const failureCount = (current?.failureCount ?? 0) + 1;
      const backoff = Math.min(this.intervalMs * 2 ** Math.min(failureCount - 1, 8), MAX_BACKOFF_MS);
      const code = extractErrorCode(error);
      const normalNoFiling = code === 'NO_ELIGIBLE_FILING' || code === 'NO_NEW_ELIGIBLE_FILING';
      await this.prisma.filingDetectionCursor.update({
        where: { stockId },
        data: {
          leaseUntil: null,
          lastCheckedAt: new Date(),
          nextCheckAt: new Date(Date.now() + (normalNoFiling ? this.intervalMs : backoff)),
          failureCount: normalNoFiling ? 0 : failureCount,
          lastError: normalNoFiling ? null : String(error).slice(0, 500),
        },
      });
      if (!normalNoFiling) {
        this.logger.warn(`检测 ${stockId} 失败（第 ${failureCount} 次，${backoff}ms 后重试）：${String(error)}`);
      }
    }
  }
}

export function parsePositiveInteger(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
  name: string,
): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

function extractErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const direct = (error as { code?: unknown }).code;
  if (typeof direct === 'string') return direct;
  const response = (error as { response?: unknown }).response;
  if (response && typeof response === 'object' && !Array.isArray(response)) {
    const code = (response as Record<string, unknown>).code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}
