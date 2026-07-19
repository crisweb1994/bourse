import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type {
  AnalysisChatContext,
  AnalysisChatPort,
  AnalysisChatSummary,
} from '../chat/types';

/** Read-only Analysis boundary for Chat. Chat never receives the repository. */
@Injectable()
export class AnalysisChatService implements AnalysisChatPort {
  constructor(private readonly prisma: PrismaService) {}

  async getAnalysisContext(input: {
    userId: string;
    stockId: string;
    analysisId: string;
    sectionTypes?: string[];
  }): Promise<AnalysisChatContext> {
    const analysis = await this.prisma.analysis.findFirst({
      where: {
        id: input.analysisId,
        userId: input.userId,
        stockId: input.stockId,
      },
      include: {
        evidenceSnapshot: true,
        sections: { orderBy: { order: 'asc' } },
      },
    });
    if (!analysis) throw new NotFoundException('Analysis not found');
    if (!['COMPLETED', 'PARTIAL_FAILED'].includes(analysis.status)) {
      throw new BadRequestException('Only completed Analysis can be used as Chat context');
    }

    const wanted = input.sectionTypes?.length
      ? new Set(input.sectionTypes.map((value) => value.toUpperCase()))
      : undefined;
    const sections = analysis.sections
      .filter((section) => !wanted || wanted.has(section.type))
      .map((section) => ({
        id: section.id,
        type: section.type,
        status: section.status,
        reportMarkdown: section.reportMarkdown,
        structuredJson: section.structuredJson,
        citations: section.citations,
      }));

    return {
      ...this.toSummary(analysis),
      promptVersion: analysis.promptVersion,
      ...(analysis.evidenceSnapshot
        ? {
            snapshot: {
              id: analysis.evidenceSnapshot.id,
              schemaVersion: analysis.evidenceSnapshot.schemaVersion,
              evidencePackVersion: analysis.evidenceSnapshot.evidencePackVersion,
              capturedAt: analysis.evidenceSnapshot.capturedAt.toISOString(),
              dataAsOf: analysis.evidenceSnapshot.dataAsOf,
              sourceMode: analysis.evidenceSnapshot.sourceMode,
              degraded: analysis.evidenceSnapshot.degraded,
              missingFields: analysis.evidenceSnapshot.missingFields,
              payload: analysis.evidenceSnapshot.payload as any,
              sourceSnapshots: analysis.evidenceSnapshot.sourceSnapshots,
              contentHash: analysis.evidenceSnapshot.contentHash,
              metadata: {
                provider: analysis.aiProvider,
                model: analysis.aiModel,
                promptVersion: analysis.promptVersion,
              },
            },
          }
        : {}),
      sections,
    };
  }

  async listEligibleAnalyses(input: {
    userId: string;
    stockId: string;
  }): Promise<AnalysisChatSummary[]> {
    const rows = await this.prisma.analysis.findMany({
      where: {
        userId: input.userId,
        stockId: input.stockId,
        status: { in: ['COMPLETED', 'PARTIAL_FAILED'] },
      },
      select: {
        id: true,
        stockId: true,
        symbol: true,
        analysisType: true,
        status: true,
        generatedAt: true,
        dataAsOf: true,
        overallSignal: true,
        overallConfidence: true,
        degradedSource: true,
        evidenceSnapshot: { select: { id: true, degraded: true } },
      },
      orderBy: [{ generatedAt: 'desc' }, { createdAt: 'desc' }],
      take: 20,
    });
    return rows.map((row) => this.toSummary(row));
  }

  private toSummary(row: any): AnalysisChatSummary {
    return {
      id: row.id,
      stockId: row.stockId,
      symbol: row.symbol,
      analysisType: row.analysisType,
      status: row.status,
      generatedAt: row.generatedAt?.toISOString() ?? null,
      dataAsOf: row.dataAsOf ?? null,
      overallSignal: row.overallSignal ?? null,
      overallConfidence: row.overallConfidence ?? null,
      degraded: Boolean(row.degradedSource || row.evidenceSnapshot?.degraded),
      hasEvidenceSnapshot: Boolean(row.evidenceSnapshot),
    };
  }
}
