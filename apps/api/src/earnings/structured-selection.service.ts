import { Injectable } from '@nestjs/common';
import { Prisma, type FinancialDataSnapshot } from '@prisma/client';
import type { FinancialsBundleV2 } from '@bourse/market-data';
import { canonicalJsonHash } from '@bourse/analysis';
import { PrismaService } from '../prisma/prisma.service';

/**
 * 结构化财务快照持久化（docs/structured-first-earnings-architecture.md §12）。
 * FinancialDataSnapshot：不可变 normalized payload + stable content hash，
 * 按 (stockId, provider, contentHash, schemaVersion) 幂等去重。
 * 事实级 provenance.snapshotId（normalizedPayload 内）是权威引用。
 */

@Injectable()
export class StructuredSelectionService {
  constructor(private readonly prisma: PrismaService) {}

  /** 幂等保存不可变快照；内容未变时返回已有行。 */
  async saveSnapshot(
    stockId: string,
    bundle: FinancialsBundleV2,
  ): Promise<FinancialDataSnapshot> {
    const contentHash = stableHash(bundle);
    return this.prisma.financialDataSnapshot.upsert({
      where: {
        stockId_provider_contentHash_schemaVersion: {
          stockId,
          provider: bundle.provider,
          contentHash,
          schemaVersion: bundle.schemaVersion,
        },
      },
      update: {},
      create: {
        stockId,
        provider: bundle.provider,
        sourceUrl: bundle.sourceUrl,
        schemaVersion: bundle.schemaVersion,
        retrievedAt: new Date(bundle.retrievedAt),
        contentHash,
        normalizedPayload: bundle as unknown as Prisma.InputJsonValue,
      },
    });
  }
}

/** 稳定 JSON hash:委托 @bourse/analysis 的 canonical 单源实现(T2-1)。 */
export function stableHash(value: unknown): string {
  return canonicalJsonHash(value);
}
