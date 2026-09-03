import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { EarningsGenerationService } from './earnings-generation.service';

const DEFAULT_INTERVAL_MS = 5 * 60_000;
const MAX_BACKOFF_MS = 6 * 60 * 60_000;
const BATCH_SIZE = 50;
const CONCURRENCY = 5;

@Injectable()
export class FilingDetectionScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(FilingDetectionScheduler.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly generations: EarningsGenerationService,
  ) {}

  onModuleInit(): void {
    void this.tick();
    this.timer = setInterval(() => void this.tick(), DEFAULT_INTERVAL_MS);
    this.logger.log(`财报检测已启动（每 ${DEFAULT_INTERVAL_MS / 60_000}min）`);
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
      if (watchlistStockIds.length === 0) return;
      const due = await this.prisma.filingDetectionCursor.findMany({
        where: { stockId: { in: watchlistStockIds }, nextCheckAt: { lte: new Date() } },
        orderBy: { nextCheckAt: 'asc' },
        take: BATCH_SIZE,
        select: { stockId: true },
      });
      for (let index = 0; index < due.length; index += CONCURRENCY) {
        await Promise.all(due.slice(index, index + CONCURRENCY).map(({ stockId }) => this.scanOne(stockId)));
      }
    } catch (error) {
      // 与 digest-scheduler 同款纪律:单次 tick 失败只记日志,不成为
      // unhandled rejection 杀掉进程,下个窗口自动补。
      this.logger.error(
        `财报检测 tick 失败: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.running = false;
    }
  }

  private async syncWatchlistCursors(): Promise<string[]> {
    const watchlist = await this.prisma.watchlistItem.findMany({
      where: { stock: { market: { in: ['US', 'CN', 'HK'] } } },
      distinct: ['stockId'],
      select: { stockId: true },
    });
    const now = new Date();
    await Promise.all(watchlist.map((row) => this.prisma.filingDetectionCursor.upsert({
      where: { stockId: row.stockId },
      update: {},
      create: { stockId: row.stockId, nextCheckAt: now },
    })));
    return watchlist.map((row) => row.stockId);
  }

  private async scanOne(stockId: string): Promise<void> {
    const startedAt = Date.now();
    try {
      await this.generations.createDetected(stockId);
      await this.prisma.filingDetectionCursor.update({
        where: { stockId },
        data: {
          nextCheckAt: new Date(Date.now() + DEFAULT_INTERVAL_MS),
          failureCount: 0,
        },
      });
      this.logger.debug(`检测 ${stockId} 完成，${Date.now() - startedAt}ms`);
    } catch (error) {
      const current = await this.prisma.filingDetectionCursor.findUnique({ where: { stockId } });
      const failureCount = (current?.failureCount ?? 0) + 1;
      const backoff = Math.min(DEFAULT_INTERVAL_MS * 2 ** Math.min(failureCount - 1, 8), MAX_BACKOFF_MS);
      const code = extractErrorCode(error);
      const normalNoFiling = code === 'NO_ELIGIBLE_FILING' || code === 'NO_NEW_ELIGIBLE_FILING';
      await this.prisma.filingDetectionCursor.update({
        where: { stockId },
        data: {
          nextCheckAt: new Date(Date.now() + (normalNoFiling ? DEFAULT_INTERVAL_MS : backoff)),
          failureCount: normalNoFiling ? 0 : failureCount,
        },
      });
      if (!normalNoFiling) {
        this.logger.warn(`检测 ${stockId} 失败（第 ${failureCount} 次，${backoff}ms 后重试）：${String(error)}`);
      }
    }
  }
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
