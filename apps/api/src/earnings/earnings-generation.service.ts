import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { computeContentHash } from '@bourse/analysis';
import { EARNINGS_EXTRACTION_PROMPT_VERSION, EARNINGS_SCHEMA_VERSION } from './earnings-prompts';
import { Prisma, type Stock } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { EarningsRunnerService } from './earnings-runner.service';
import {
  EarningsSourceError,
  EarningsSourceService,
  type EarningsRunSource,
  type PreparedEarningsSource,
} from './earnings-source.service';

@Injectable()
export class EarningsGenerationService {
  private readonly preparing = new Map<string, Promise<PreparedEarningsSource>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly sources: EarningsSourceService,
    private readonly runner: EarningsRunnerService,
    private readonly config: ConfigService,
  ) {}

  async create(userId: string, stockId: string, clientRequestId: string) {
    this.assertEnabled();
    const watchlistItem = await this.prisma.watchlistItem.findFirst({
      where: { userId, stockId },
      include: { stock: true },
    });
    if (!watchlistItem) {
      throw new ForbiddenException('Stock must be in your watchlist before generating an earnings brief');
    }
    if (watchlistItem.stock.market === 'HK') {
      throw new ConflictException('HK earnings briefs are planned for Phase 3');
    }

    let source: EarningsRunSource;
    try {
      source = await this.prepareSource(watchlistItem.stock);
    } catch (error) {
      if (error instanceof EarningsSourceError) {
        throw new ConflictException({ code: error.code, retryable: error.retryable, message: error.message });
      }
      throw error;
    }
    return this.queueRun(watchlistItem.stock, source, userId, clientRequestId);
  }

  /** Detector-only entry point. The persisted watchlist union is the scope;
   * public-card generation never depends on an individual user's AI key. */
  async createDetected(stockId: string) {
    if (!this.isEnabled()) return null;
    const stock = await this.prisma.stock.findUnique({ where: { id: stockId } });
    if (!stock) throw new NotFoundException('Stock not found');
    if (stock.market === 'HK') return null;
    const watchlistCount = await this.prisma.watchlistItem.count({ where: { stockId } });
    if (watchlistCount === 0) return null;
    const retry = await this.retryDetectedFailure(stockId);
    if (retry) return retry;
    const source = await this.prepareSource(stock);
    return this.queueRun(stock, source);
  }

  private async retryDetectedFailure(stockId: string) {
    const failed = await this.prisma.earningsGenerationRun.findFirst({
      where: {
        stockId,
        retryable: true,
        status: { in: ['FAILED', 'BUDGET_EXHAUSTED'] },
        completedAt: { not: null },
      },
      orderBy: { completedAt: 'asc' },
    });
    if (!failed?.completedAt) return null;
    const retryAt = detectedRetryAt(failed.status, failed.attempt, failed.completedAt);
    if (retryAt.getTime() > Date.now()) return null;
    const updated = await this.prisma.earningsGenerationRun.updateMany({
      where: {
        id: failed.id,
        retryable: true,
        status: failed.status,
        completedAt: failed.completedAt,
      },
      data: {
        status: 'QUEUED',
        stage: 'DISCOVER',
        attempt: { increment: 1 },
        errorCode: null,
        errorMessage: null,
        startedAt: null,
        completedAt: null,
      },
    });
    if (updated.count !== 1) return null;
    const run = await this.prisma.earningsGenerationRun.findUnique({ where: { id: failed.id } });
    if (run) this.runner.schedule(run.id);
    return run;
  }

  private async prepareSource(stock: Stock): Promise<EarningsRunSource> {
    try {
      return await this.prepareSingleFlight(stock);
    } catch (error) {
      if (error instanceof EarningsSourceError && error.fallbackSource) {
        return error.fallbackSource;
      }
      throw error;
    }
  }

  private async queueRun(
    stock: Stock,
    source: EarningsRunSource,
    userId?: string,
    clientRequestId?: string,
  ) {
    const stockId = stock.id;

    const idempotencyKey = buildEarningsGenerationIdempotencyKey(stockId, source);
    const sourceDescriptor = source.kind === 'filing'
      ? {
          kind: source.kind,
          filingId: source.filingId,
          derivationId: source.derivationId,
          provider: source.provider,
          sourceDocumentId: source.sourceDocumentId,
          sourceGroupId: source.sourceGroupId,
          formType: source.formType,
          title: source.title,
          sourceUrl: source.sourceUrl,
          publishedAt: source.publishedAt,
          ...(source.expectedPeriodEndOn ? { expectedPeriodEndOn: source.expectedPeriodEndOn } : {}),
          documentKind: source.documentKind,
        }
      : source;

    let run;
    try {
      run = await this.prisma.earningsGenerationRun.create({
        data: {
          stockId,
          requestedByUserId: userId,
          clientRequestId,
          idempotencyKey,
          sourceDescriptor: sourceDescriptor as unknown as Prisma.InputJsonValue,
        },
      });
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
        throw error;
      }
      run = await this.prisma.earningsGenerationRun.findUnique({ where: { idempotencyKey } });
      if (!run) throw error;
    }

    if (run.status === 'QUEUED') this.runner.schedule(run.id);
    return run;
  }

  async retry(userId: string, runId: string) {
    this.assertEnabled();
    const run = await this.prisma.earningsGenerationRun.findUnique({ where: { id: runId } });
    if (!run) throw new NotFoundException('Earnings generation not found');
    await this.assertStockScope(userId, run.stockId);
    if (!run.retryable || !['FAILED', 'BUDGET_EXHAUSTED'].includes(run.status)) {
      throw new ConflictException('This earnings generation cannot be retried');
    }
    const updated = await this.prisma.earningsGenerationRun.update({
      where: { id: run.id },
      data: {
        status: 'QUEUED',
        stage: 'DISCOVER',
        attempt: { increment: 1 },
        errorCode: null,
        errorMessage: null,
        startedAt: null,
        completedAt: null,
      },
    });
    this.runner.schedule(updated.id);
    return updated;
  }

  async assertStockScope(userId: string, stockId: string): Promise<void> {
    const count = await this.prisma.watchlistItem.count({ where: { userId, stockId } });
    if (count === 0) throw new ForbiddenException('Stock is outside your watchlist scope');
  }

  private prepareSingleFlight(stock: Parameters<EarningsSourceService['discoverAndIngest']>[0]) {
    const current = this.preparing.get(stock.id);
    if (current) return current;
    const task = this.sources.discoverAndIngest(stock).finally(() => this.preparing.delete(stock.id));
    this.preparing.set(stock.id, task);
    return task;
  }

  private isEnabled(): boolean {
    return this.config.get<string>('EARNINGS_BRIEF_ENABLED')?.toLowerCase() !== 'false';
  }

  private assertEnabled(): void {
    if (!this.isEnabled()) {
      throw new ServiceUnavailableException({
        code: 'FEATURE_DISABLED',
        message: 'Earnings brief is disabled',
      });
    }
  }
}

const DETECTED_RETRY_BASE_MS = 5 * 60_000;
const DETECTED_RETRY_MAX_MS = 6 * 60 * 60_000;

export function detectedRetryAt(
  status: string,
  attempt: number,
  completedAt: Date,
): Date {
  if (status === 'BUDGET_EXHAUSTED') {
    return new Date(Date.UTC(
      completedAt.getUTCFullYear(),
      completedAt.getUTCMonth(),
      completedAt.getUTCDate() + 1,
    ));
  }
  const delay = Math.min(
    DETECTED_RETRY_BASE_MS * 2 ** Math.min(Math.max(attempt - 1, 0), 8),
    DETECTED_RETRY_MAX_MS,
  );
  return new Date(completedAt.getTime() + delay);
}

export function buildEarningsGenerationIdempotencyKey(
  stockId: string,
  source: EarningsRunSource,
): string {
  const sourceVersion = source.kind === 'filing'
    ? `${source.derivationId}:${source.contentHash}`
    : `${source.reason}:${source.sourceDocumentId}`;
  return computeContentHash({
    text: JSON.stringify({
      pipelineVersion: 'earnings-pipeline-v4',
      stockId,
      provider: source.provider,
      sourceDocumentId: source.sourceDocumentId,
      sourceKind: source.kind,
      sourceVersion,
      promptVersion: EARNINGS_EXTRACTION_PROMPT_VERSION,
      schemaVersion: EARNINGS_SCHEMA_VERSION,
    }),
  });
}
