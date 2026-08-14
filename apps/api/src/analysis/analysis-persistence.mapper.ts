import type { SseEvent } from '@bourse/analysis';
import {
  isAnalysisStatus,
  isConfidence,
  isOverallSignal,
  isSectionType,
  type AnalysisMode,
  type AnalysisTerminalStatus,
  type OverallSignal,
} from '@bourse/shared-types';
import {
  AnalysisStatus as PrismaAnalysisStatus,
  Confidence as PrismaConfidence,
  OverallSignal as PrismaOverallSignal,
  SectionStatus as PrismaSectionStatus,
  SectionType as PrismaSectionType,
  type Prisma,
} from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';

function toPrismaAnalysisStatus(status: string): PrismaAnalysisStatus {
  if (!isAnalysisStatus(status)) {
    throw new Error(`Unknown analysis status: ${status}`);
  }
  return PrismaAnalysisStatus[status];
}

function toPrismaSectionType(sectionType: string): PrismaSectionType {
  if (!isSectionType(sectionType)) {
    throw new Error(`Unknown section type: ${sectionType}`);
  }
  return PrismaSectionType[sectionType];
}

function toPrismaSectionStatus(status: string): PrismaSectionStatus {
  if (status === 'COMPLETED') return PrismaSectionStatus.COMPLETED;
  if (status === 'CANCELLED') return PrismaSectionStatus.CANCELLED;
  if (status === 'SKIPPED') return PrismaSectionStatus.SKIPPED;
  return PrismaSectionStatus.FAILED;
}

function toPrismaJson(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function optionalPrismaJson(
  value: unknown,
): Prisma.InputJsonValue | undefined {
  if (value === null || value === undefined) return undefined;
  return toPrismaJson(value);
}

function toOverallSignal(value: unknown): OverallSignal | null {
  if (typeof value !== 'string') return null;
  if (isOverallSignal(value)) return value;
  return null;
}

export interface AnalysisSectionAccumulator {
  sectionId: string;
  markdown: string;
  /** Kept in memory for snapshot provenance; not stored as a second DB fact. */
  citations: Array<{
    title: string;
    url: string;
    sourceType: string;
    retrievedAt: string;
  }>;
  structuredJson: unknown;
}

export interface PersistRunDoneInput {
  analysisId: string;
  mode: AnalysisMode;
  aiModel: string;
  terminalStatus: AnalysisTerminalStatus;
  summaryMarkdown: string;
  summaryJson: unknown;
  summaryDataAsOf: string | null;
  todayDate: string;
  degradedSourceMark: 'WEB_SEARCH_FALLBACK' | null;
  inputTokens: number | null;
  outputTokens: number | null;
  doneEvent: Extract<SseEvent, { type: 'done' }>;
}

export class AnalysisPersistenceMapper {
  constructor(private readonly prisma: PrismaService) {}

  async markQueuedSectionsInProgress(sectionIds: string[]) {
    if (sectionIds.length === 0) return;
    await this.prisma.analysisSection.updateMany({
      where: { id: { in: sectionIds }, status: PrismaSectionStatus.PENDING },
      data: { status: PrismaSectionStatus.IN_PROGRESS, startedAt: new Date() },
    });
  }

  async persistSectionSkipped(sectionId: string, reason = 'Section skipped') {
    await this.prisma.analysisSection.updateMany({
      where: { id: sectionId, status: PrismaSectionStatus.IN_PROGRESS },
      data: {
        status: PrismaSectionStatus.SKIPPED,
        errorCode: 'INSUFFICIENT_REQUIRED_FACTS',
        errorMessage: reason,
        completedAt: new Date(),
      },
    });
  }

  async persistSectionComplete(
    event: Extract<SseEvent, { type: 'section_complete' }>,
    accumulator: AnalysisSectionAccumulator,
  ) {
    await this.prisma.analysisSection.updateMany({
      where: { id: accumulator.sectionId, status: PrismaSectionStatus.IN_PROGRESS },
      data: {
        status: toPrismaSectionStatus(event.status),
        reportMarkdown: accumulator.markdown || null,
        structuredJson: optionalPrismaJson(accumulator.structuredJson),
        completedAt: new Date(),
        errorCode: null,
        errorMessage: null,
      },
    });
  }

  async persistSectionErrorById(
    sectionId: string,
    message: string,
    errorCode = 'SECTION_FAILED',
  ) {
    await this.prisma.analysisSection.updateMany({
      where: { id: sectionId, status: PrismaSectionStatus.IN_PROGRESS },
      data: {
        status: PrismaSectionStatus.FAILED,
        errorCode,
        errorMessage: message,
        completedAt: new Date(),
      },
    });
  }

  async persistSectionErrorByType(
    analysisId: string,
    sectionType: string,
    message: string,
    errorCode = 'SECTION_FAILED',
  ) {
    await this.prisma.analysisSection.updateMany({
      where: {
        analysisId,
        type: toPrismaSectionType(sectionType),
        status: {
          in: [PrismaSectionStatus.PENDING, PrismaSectionStatus.IN_PROGRESS],
        },
      },
      data: {
        status: PrismaSectionStatus.FAILED,
        errorCode,
        errorMessage: message,
        completedAt: new Date(),
      },
    });
  }

  async persistRunDone(input: PersistRunDoneInput) {
    const summary =
      input.summaryJson && typeof input.summaryJson === 'object'
        ? (input.summaryJson as Record<string, unknown>)
        : null;
    const result = input.doneEvent.result as { signal?: unknown; confidence?: unknown };
    const overallSignal = toOverallSignal(summary?.signal ?? result.signal);
    const overallConfidence =
      typeof summary?.confidence === 'string'
        ? summary.confidence
        : typeof result.confidence === 'string'
          ? result.confidence
          : null;

    await this.prisma.analysis.updateMany({
      where: { id: input.analysisId, status: PrismaAnalysisStatus.IN_PROGRESS },
      data: {
        status: toPrismaAnalysisStatus(input.terminalStatus),
        aiModel: input.aiModel,
        completedAt: new Date(),
        ...(input.summaryMarkdown ? { summaryMarkdown: input.summaryMarkdown } : {}),
        ...(input.summaryJson !== null
          ? { summaryJson: toPrismaJson(input.summaryJson) }
          : {}),
        ...(overallSignal
          ? { overallSignal: PrismaOverallSignal[overallSignal] }
          : { overallSignal: null }),
        ...(overallConfidence && isConfidence(overallConfidence)
          ? { overallConfidence: PrismaConfidence[overallConfidence] }
          : { overallConfidence: null }),
        dataAsOf: input.summaryDataAsOf ?? input.todayDate,
        ...(input.inputTokens !== null ? { inputTokens: input.inputTokens } : {}),
        ...(input.outputTokens !== null ? { outputTokens: input.outputTokens } : {}),
      },
    });
  }

  async persistRunFailed(analysisId: string, message?: string, errorCode = 'RUN_FAILED') {
    await this.prisma.analysis.updateMany({
      where: { id: analysisId, status: PrismaAnalysisStatus.IN_PROGRESS },
      data: {
        status: PrismaAnalysisStatus.FAILED,
        errorCode,
        errorMessage: message ?? null,
        completedAt: new Date(),
      },
    });
  }

  async persistRunCancelled(input: {
    analysisId: string;
    inputTokens: number | null;
    outputTokens: number | null;
  }) {
    await this.prisma.analysis.updateMany({
      where: {
        id: input.analysisId,
        status: { in: [PrismaAnalysisStatus.PENDING, PrismaAnalysisStatus.IN_PROGRESS] },
      },
      data: {
        status: PrismaAnalysisStatus.CANCELLED,
        errorCode: 'CANCELLED_BY_USER',
        errorMessage: 'Cancelled by user',
        completedAt: new Date(),
        ...(input.inputTokens !== null ? { inputTokens: input.inputTokens } : {}),
        ...(input.outputTokens !== null ? { outputTokens: input.outputTokens } : {}),
      },
    });
  }

  async sweepOrphanSections(input: {
    analysisId: string;
    orphanTypes: string[];
    terminalStatus: AnalysisTerminalStatus;
  }) {
    if (input.orphanTypes.length === 0) return;
    const cancelled = input.terminalStatus === 'CANCELLED';
    await this.prisma.analysisSection.updateMany({
      where: {
        analysisId: input.analysisId,
        type: { in: input.orphanTypes.map(toPrismaSectionType) },
        status: { in: [PrismaSectionStatus.PENDING, PrismaSectionStatus.IN_PROGRESS] },
      },
      data: {
        status: cancelled ? PrismaSectionStatus.CANCELLED : PrismaSectionStatus.FAILED,
        errorCode: cancelled ? 'CANCELLED_BY_USER' : 'RUN_INTERRUPTED',
        errorMessage: cancelled
          ? 'Cancelled before this section completed'
          : 'Run ended before this section completed',
        completedAt: new Date(),
      },
    });
  }
}
