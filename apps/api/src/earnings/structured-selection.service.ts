import { Injectable } from '@nestjs/common';
import { Prisma, type FinancialDataSnapshot } from '@prisma/client';
import type { FinancialsBundleV2 } from '@bourse/market-data';
import { canonicalJsonHash, type StructuredEarningsSelection } from '@bourse/analysis';
import { PrismaService } from '../prisma/prisma.service';

/**
 * 结构化快照 + selection 持久化（docs/structured-first-earnings-architecture.md §12）。
 *
 * - FinancialDataSnapshot：不可变 normalized payload + stable content hash，
 *   按 (stockId, provider, contentHash, schemaVersion) 幂等去重；
 * - EarningsStructuredSelection：event 级 selection（knowledgeCutoffAt +
 *   retryAt），selectionVersion 由 status/period/fact IDs 稳定哈希得到——
 *   只有快照 hash 或选择结果变化时才产生新版本，避免重试无意义膨胀。
 *   事实级 provenance.snapshotId（normalizedPayload 内）是权威引用。
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
        sourceNature: bundle.sourceNature,
        qualityTier: bundle.qualityTier,
        sourceUrl: bundle.sourceUrl,
        schemaVersion: bundle.schemaVersion,
        retrievedAt: new Date(bundle.retrievedAt),
        contentHash,
        normalizedPayload: bundle as unknown as Prisma.InputJsonValue,
      },
    });
  }

  /** 幂等保存 selection；同一 (eventId, selectionVersion) 不重复。 */
  async saveSelection(input: {
    eventId: string;
    selection: StructuredEarningsSelection;
    knowledgeCutoffAt: string;
    retryAt?: string;
  }): Promise<void> {
    const selectionVersion = selectionVersionOf(input.selection);
    const existing = await this.prisma.earningsStructuredSelection.findUnique({
      where: {
        eventId_selectionVersion: {
          eventId: input.eventId,
          selectionVersion,
        },
      },
      select: { id: true },
    });
    if (existing) return;

    await this.prisma.earningsStructuredSelection.create({
      data: {
        eventId: input.eventId,
        selectionVersion,
        status: input.selection.status,
        selectedPeriodId:
          input.selection.status === 'ready' ? input.selection.period.id : undefined,
        diagnostics: input.selection.diagnostics as unknown as Prisma.InputJsonValue,
        knowledgeCutoffAt: new Date(input.knowledgeCutoffAt),
        retryAt: input.retryAt ? new Date(input.retryAt) : null,
      },
    });
  }
}

/** 稳定 selection 版本：status + selectedPeriodId + 排序后的 fact IDs。 */
export function selectionVersionOf(selection: StructuredEarningsSelection): string {
  const facts =
    'facts' in selection ? selection.facts.map((fact) => fact.id).sort() : [];
  const selectedPeriodId = selection.status === 'ready' ? selection.period.id : null;
  return stableHash({ status: selection.status, selectedPeriodId, facts });
}

/** 稳定 JSON hash:委托 @bourse/analysis 的 canonical 单源实现(T2-1)。 */
export function stableHash(value: unknown): string {
  return canonicalJsonHash(value);
}
