import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { computeUsd } from '@bourse/analysis';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

const BUDGET_LOCK_KEY = 'bourse:earnings:daily-budget';
// Extraction is configurable up to 10 minutes. Keep one minute of cleanup
// grace so a concurrent reservation cannot fail a still-live max-timeout run.
const STALE_RESERVATION_MS = 11 * 60 * 1000;

export type BudgetReservationResult =
  | { available: true; reservedUsd: number }
  | { available: false; code: 'LLM_DISABLED' | 'BUDGET_EXHAUSTED' };

@Injectable()
export class EarningsBudgetService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async reserve(
    runId: string,
    model: string,
    systemPrompt: string,
    userPrompt: string,
    maxOutputTokens: number,
  ): Promise<BudgetReservationResult> {
    if (this.config.get<string>('EARNINGS_LLM_ENABLED')?.toLowerCase() === 'false') {
      return { available: false, code: 'LLM_DISABLED' };
    }
    const limit = Number(this.config.get<string>('EARNINGS_DAILY_BUDGET_USD') ?? '5');
    if (!Number.isFinite(limit) || limit < 0) {
      throw new Error('INVALID_BUDGET_CONFIG');
    }
    const reservedUsd = estimateStructuredOutputReservationUsd(
      model,
      systemPrompt,
      userPrompt,
      maxOutputTokens,
    );
    const now = new Date();
    const since = utcDayStart(now);

    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${BUDGET_LOCK_KEY}))`;
      await tx.earningsGenerationRun.updateMany({
        where: {
          status: 'RUNNING',
          budgetReservedUsd: { gt: 0 },
          startedAt: { lt: new Date(now.getTime() - STALE_RESERVATION_MS) },
        },
        data: {
          status: 'FAILED',
          retryable: true,
          errorCode: 'GENERATION_TIMEOUT',
          errorMessage: 'Generation exceeded the reservation lease',
          budgetReservedUsd: new Prisma.Decimal(0),
          completedAt: now,
        },
      });
      const usage = await tx.earningsGenerationRun.aggregate({
        // A queued run may start or retry on a later UTC day. Charging by the
        // current attempt's startedAt keeps that spend inside today's cap.
        // costUsd is cumulative, so cross-day retries are conservatively
        // over-counted rather than allowing budget leakage.
        where: { startedAt: { gte: since } },
        _sum: { costUsd: true, budgetReservedUsd: true },
      });
      const committed =
        (usage._sum.costUsd?.toNumber() ?? 0) +
        (usage._sum.budgetReservedUsd?.toNumber() ?? 0);
      if (committed + reservedUsd > limit) {
        return { available: false, code: 'BUDGET_EXHAUSTED' } as const;
      }
      const updated = await tx.earningsGenerationRun.updateMany({
        where: { id: runId, status: 'RUNNING', budgetReservedUsd: { equals: 0 } },
        data: { budgetReservedUsd: new Prisma.Decimal(reservedUsd) },
      });
      if (updated.count !== 1) throw new Error('BUDGET_RESERVATION_STATE_CONFLICT');
      return { available: true, reservedUsd } as const;
    });
  }

  async settle(runId: string, actualCostUsd: number): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${BUDGET_LOCK_KEY}))`;
      await tx.earningsGenerationRun.update({
        where: { id: runId },
        data: {
          costUsd: new Prisma.Decimal(actualCostUsd),
          budgetReservedUsd: new Prisma.Decimal(0),
        },
      });
    });
  }

  async release(runId: string): Promise<void> {
    await this.prisma.earningsGenerationRun.updateMany({
      where: { id: runId, budgetReservedUsd: { gt: 0 } },
      data: { budgetReservedUsd: new Prisma.Decimal(0) },
    });
  }
}

export function estimateStructuredOutputReservationUsd(
  model: string,
  systemPrompt: string,
  userPrompt: string,
  maxOutputTokens: number,
): number {
  const inputByteUpperBound = Buffer.byteLength(systemPrompt) + Buffer.byteLength(userPrompt);
  const repairInstructionUpperBound = 2_000;
  const inputTokensUpperBound =
    inputByteUpperBound * 2 + maxOutputTokens + repairInstructionUpperBound;
  const outputTokensUpperBound = maxOutputTokens * 2;
  return Math.ceil(
    computeUsd(model, inputTokensUpperBound, outputTokensUpperBound) * 1_000_000,
  ) / 1_000_000;
}

function utcDayStart(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
}
