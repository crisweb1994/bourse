import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { AnalysisChatContext, AnalysisChatSummary } from '../chat/types';

@Injectable()
export class AnalysisChatService {
  constructor(private readonly prisma: PrismaService) {}

  async getAnalysisContext(input: {
    userId: string;
    stockId: string;
    analysisId: string;
    sectionTypes?: string[];
  }): Promise<AnalysisChatContext> {
    const analysis = await this.prisma.analysis.findFirst({
      where: { id: input.analysisId, userId: input.userId, stockId: input.stockId },
      include: { evidenceSnapshot: true, sections: { orderBy: { order: 'asc' } } },
    });
    if (!analysis) throw new NotFoundException('Analysis not found');
    if (!['COMPLETED', 'PARTIAL_FAILED'].includes(analysis.status)) {
      throw new BadRequestException('Only completed or partially completed Analysis can be used as Chat context');
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
        citations: collectCitations(section.structuredJson),
      }));
    return {
      ...this.toSummary(analysis),
      ...(analysis.evidenceSnapshot
        ? {
            snapshot: {
              id: analysis.evidenceSnapshot.id,
              capturedAt: analysis.evidenceSnapshot.capturedAt.toISOString(),
              dataAsOf: analysis.evidenceSnapshot.dataAsOf,
              degraded: analysis.evidenceSnapshot.degraded,
              missingFields: analysis.evidenceSnapshot.missingFields,
              payload: analysis.evidenceSnapshot.payload as any,
              sourceSnapshots: analysis.evidenceSnapshot.sourceSnapshots,
            },
          }
        : {}),
      sections,
    };
  }

  async listEligibleAnalyses(input: { userId: string; stockId: string }): Promise<AnalysisChatSummary[]> {
    const rows = await this.prisma.analysis.findMany({
      where: { userId: input.userId, stockId: input.stockId, status: { in: ['COMPLETED', 'PARTIAL_FAILED'] } },
      select: {
        id: true,
        stockId: true,
        symbol: true,
        mode: true,
        focusWindow: true,
        status: true,
        createdAt: true,
        completedAt: true,
        dataAsOf: true,
        overallSignal: true,
        overallConfidence: true,
        evidenceSnapshot: { select: { id: true, degraded: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
    return rows.map((row) => this.toSummary(row));
  }

  private toSummary(row: any): AnalysisChatSummary {
    return {
      id: row.id,
      stockId: row.stockId,
      symbol: row.symbol,
      mode: row.mode,
      focusWindow: mapFocusWindow(row.focusWindow),
      status: row.status,
      createdAt: row.createdAt.toISOString(),
      completedAt: row.completedAt?.toISOString() ?? null,
      dataAsOf: typeof row.dataAsOf === 'string' ? row.dataAsOf : null,
      overallSignal: row.overallSignal ?? null,
      overallConfidence: row.overallConfidence ?? null,
      degraded: Boolean(row.evidenceSnapshot?.degraded),
      hasEvidenceSnapshot: Boolean(row.evidenceSnapshot),
    };
  }
}

function mapFocusWindow(value: string): string {
  return ({ D30: '30D', D90: '90D', Y1: '1Y', Y3: '3Y' } as Record<string, string>)[value] ?? value;
}

function collectCitations(value: unknown): Array<{ title: string; url: string; claim: string }> {
  const data = value as any;
  const findings = Array.isArray(data?.findings) ? data.findings : [];
  const output: Array<{ title: string; url: string; claim: string }> = [];
  const seen = new Set<string>();
  for (const finding of findings) {
    for (const evidence of Array.isArray(finding?.evidence) ? finding.evidence : []) {
      for (const citation of Array.isArray(evidence?.citations) ? evidence.citations : []) {
        if (typeof citation?.url !== 'string' || seen.has(citation.url)) continue;
        seen.add(citation.url);
        output.push({
          title: typeof citation.title === 'string' ? citation.title : citation.url,
          url: citation.url,
          claim: typeof evidence.claim === 'string' ? evidence.claim : '',
        });
      }
    }
  }
  return output;
}
