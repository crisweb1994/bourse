import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { computeContentHash, INVESTOR_RELATIONS_PROMPT_VERSION, INVESTOR_RELATIONS_SCHEMA_VERSION } from '@bourse/analysis';
import { Prisma, type Stock } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { InvestorRelationsRunnerService } from './investor-relations-runner.service';
import { InvestorRelationsSourceError, InvestorRelationsSourceService, type PreparedInvestorRelationsSource } from './investor-relations-source.service';

@Injectable()
export class InvestorRelationsGenerationService {
  private readonly preparing = new Map<string, Promise<PreparedInvestorRelationsSource>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly sources: InvestorRelationsSourceService,
    private readonly runner: InvestorRelationsRunnerService,
  ) {}

  async create(userId: string, stockId: string, clientRequestId: string) {
    const item = await this.prisma.watchlistItem.findFirst({ where: { userId, stockId }, include: { stock: true } });
    if (!item) throw new ForbiddenException('Stock must be in your watchlist before generating investor relations records');
    if (item.stock.market !== 'CN') throw new ConflictException('Investor relations records currently support A-shares only');
    return this.prepareAndQueue(item.stock, userId, clientRequestId);
  }

  async retry(userId: string, runId: string) {
    const run = await this.prisma.investorRelationsGenerationRun.findUnique({ where: { id: runId } });
    if (!run) throw new NotFoundException('Investor relations generation not found');
    await this.assertStockScope(userId, run.stockId);
    if (!run.retryable || run.status !== 'FAILED') {
      throw new ConflictException('This investor relations generation cannot be retried');
    }
    const updated = await this.prisma.investorRelationsGenerationRun.update({
      where: { id: run.id },
      data: { status: 'QUEUED', stage: 'DISCOVER', attempt: { increment: 1 }, errorCode: null, errorMessage: null, startedAt: null, completedAt: null },
    });
    this.runner.schedule(updated.id);
    return updated;
  }

  async assertStockScope(userId: string, stockId: string): Promise<void> {
    if (await this.prisma.watchlistItem.count({ where: { userId, stockId } }) === 0) {
      throw new ForbiddenException('Stock is outside your watchlist scope');
    }
  }

  private async prepareAndQueue(stock: Stock, userId?: string, clientRequestId?: string) {
    let source: PreparedInvestorRelationsSource;
    try {
      source = await this.prepareSingleFlight(stock);
    } catch (error) {
      if (error instanceof InvestorRelationsSourceError) {
        throw new ConflictException({ code: error.code, retryable: error.retryable, message: error.message });
      }
      throw error;
    }
    const idempotencyKey = computeContentHash({
      text: JSON.stringify({
        pipeline: 'investor-relations-v1',
        stockId: stock.id,
        provider: source.provider,
        sourceDocumentId: source.sourceDocumentId,
        sourceVersion: `${source.derivationId}:${source.contentHash}`,
        promptVersion: INVESTOR_RELATIONS_PROMPT_VERSION,
        schemaVersion: INVESTOR_RELATIONS_SCHEMA_VERSION,
      }),
    });
    let run;
    try {
      run = await this.prisma.investorRelationsGenerationRun.create({
        data: {
          stockId: stock.id,
          requestedByUserId: userId,
          clientRequestId,
          idempotencyKey,
          sourceDescriptor: source as unknown as Prisma.InputJsonValue,
        },
      });
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') throw error;
      run = await this.prisma.investorRelationsGenerationRun.findUnique({ where: { idempotencyKey } });
      if (!run) throw error;
    }
    if (run.status === 'QUEUED') this.runner.schedule(run.id);
    return run;
  }

  private prepareSingleFlight(stock: Stock) {
    const current = this.preparing.get(stock.id);
    if (current) return current;
    const task = this.sources.discoverAndIngest(stock).finally(() => this.preparing.delete(stock.id));
    this.preparing.set(stock.id, task);
    return task;
  }

}
