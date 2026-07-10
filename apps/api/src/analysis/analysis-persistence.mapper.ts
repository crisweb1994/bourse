import type { SseEvent } from '@bourse/analysis';
import {
  isAnalysisStatus,
  isConfidence,
  isSectionType,
  isSignal,
  type AnalysisTerminalStatus,
} from '@bourse/shared-types';
import {
  AnalysisStatus as PrismaAnalysisStatus,
  Confidence as PrismaConfidence,
  type Prisma,
  SectionType as PrismaSectionType,
  Signal as PrismaSignal,
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

function toPrismaSignal(signal: string): PrismaSignal {
  if (!isSignal(signal)) {
    throw new Error(`Unknown signal: ${signal}`);
  }
  return PrismaSignal[signal];
}

function toPrismaConfidence(confidence: string): PrismaConfidence {
  if (!isConfidence(confidence)) {
    throw new Error(`Unknown confidence: ${confidence}`);
  }
  return PrismaConfidence[confidence];
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

export interface AnalysisSectionAccumulator {
  sectionId: string;
  markdown: string;
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
  mode?: 'comprehensive' | 'single';
  modelId: string;
  terminalStatus: AnalysisTerminalStatus;
  summaryMarkdown: string;
  summaryJson: unknown;
  summaryDataAsOf: string | null;
  todayDate: string;
  degradedSourceMark: 'WEB_SEARCH_FALLBACK' | null;
  doneEvent: Extract<SseEvent, { type: 'done' }>;
}

export class AnalysisPersistenceMapper {
  constructor(private readonly prisma: PrismaService) {}

  async markQueuedSectionsInProgress(sectionIds: string[]) {
    if (sectionIds.length === 0) return;
    await this.prisma.analysisSection.updateMany({
      where: { id: { in: sectionIds } },
      data: { status: PrismaAnalysisStatus.IN_PROGRESS },
    });
  }

  async persistSectionSkipped(sectionId: string) {
    await this.prisma.analysisSection.update({
      where: { id: sectionId },
      data: { status: PrismaAnalysisStatus.FAILED },
    });
  }

  async persistSectionComplete(
    event: Extract<SseEvent, { type: 'section_complete' }>,
    accumulator: AnalysisSectionAccumulator,
  ) {
    const sectionFields = this.pickSectionFields(event, accumulator);

    await this.prisma.analysisSection.update({
      where: { id: accumulator.sectionId },
      data: {
        status: toPrismaAnalysisStatus(event.status),
        reportMarkdown: accumulator.markdown,
        structuredJson: optionalPrismaJson(accumulator.structuredJson),
        citations:
          accumulator.citations.length > 0
            ? toPrismaJson(accumulator.citations)
            : undefined,
        ...sectionFields,
      },
    });
  }

  async persistJudgeResult(
    analysisId: string,
    event: Extract<SseEvent, { type: 'judge_complete' }>,
    accumulator: AnalysisSectionAccumulator,
  ) {
    if (
      !accumulator.structuredJson ||
      typeof accumulator.structuredJson !== 'object'
    ) {
      return;
    }

    const json = accumulator.structuredJson as Record<string, unknown>;
    json.judgeResult = event.result;
    if (
      event.result.confidenceAdjustment === 'DOWNGRADE_TO_MEDIUM' ||
      event.result.confidenceAdjustment === 'DOWNGRADE_TO_LOW'
    ) {
      const target =
        event.result.confidenceAdjustment === 'DOWNGRADE_TO_LOW'
          ? 'LOW'
          : 'MEDIUM';
      const conclusion = json.conclusion as { confidence?: string } | undefined;
      if (conclusion) conclusion.confidence = target;
    }

    await this.prisma.analysisSection.updateMany({
      where: {
        analysisId,
        type: toPrismaSectionType(event.sectionType),
      },
      data: { structuredJson: toPrismaJson(accumulator.structuredJson) },
    });
  }

  async persistSectionErrorById(sectionId: string, message: string) {
    await this.prisma.analysisSection.update({
      where: { id: sectionId },
      data: {
        status: PrismaAnalysisStatus.FAILED,
        errorMessage: message,
      },
    });
  }

  async persistSectionErrorByType(
    analysisId: string,
    sectionType: string,
    message: string,
  ) {
    await this.prisma.analysisSection.updateMany({
      where: {
        analysisId,
        type: toPrismaSectionType(sectionType),
        status: {
          in: [
            PrismaAnalysisStatus.PENDING,
            PrismaAnalysisStatus.IN_PROGRESS,
          ],
        },
      },
      data: {
        status: PrismaAnalysisStatus.FAILED,
        errorMessage: message,
      },
    });
  }

  async persistRunDone(input: PersistRunDoneInput) {
    const { overallSignal, overallConfidence, dataAsOf } =
      this.pickOverallFields(input);

    await this.prisma.analysis.update({
      where: { id: input.analysisId },
      data: {
        status: toPrismaAnalysisStatus(input.terminalStatus),
        aiModel: input.modelId,
        generatedAt: new Date(),
        ...(input.mode !== 'single' && input.summaryMarkdown
          ? { summaryMarkdown: input.summaryMarkdown }
          : {}),
        ...(input.mode !== 'single' && input.summaryJson !== null
          ? { summaryJson: toPrismaJson(input.summaryJson) }
          : {}),
        ...(overallSignal && isSignal(overallSignal)
          ? { overallSignal: toPrismaSignal(overallSignal) }
          : {}),
        ...(overallConfidence && isConfidence(overallConfidence)
          ? { overallConfidence: toPrismaConfidence(overallConfidence) }
          : {}),
        ...(dataAsOf ? { dataAsOf } : {}),
        ...(input.degradedSourceMark
          ? { degradedSource: input.degradedSourceMark }
          : {}),
      },
    });
  }

  async persistRunFailed(analysisId: string) {
    await this.prisma.analysis.update({
      where: { id: analysisId },
      data: { status: PrismaAnalysisStatus.FAILED },
    });
  }

  async sweepOrphanSections(input: {
    analysisId: string;
    orphanTypes: string[];
    terminalStatus: AnalysisTerminalStatus;
  }) {
    if (input.orphanTypes.length === 0) return;

    const orphanStatus = this.orphanStatusFor(input.terminalStatus);
    const orphanMsg = this.orphanMessageFor(input.terminalStatus);

    await this.prisma.analysisSection.updateMany({
      where: {
        analysisId: input.analysisId,
        type: {
          in: input.orphanTypes.map((type) => toPrismaSectionType(type)),
        },
        status: {
          in: [
            PrismaAnalysisStatus.PENDING,
            PrismaAnalysisStatus.IN_PROGRESS,
          ],
        },
      },
      data: {
        status: orphanStatus,
        errorMessage: orphanMsg,
      },
    });
  }

  private pickOverallFields(input: PersistRunDoneInput): {
    overallSignal?: string;
    overallConfidence?: string;
    dataAsOf?: string;
  } {
    if (input.mode === 'single') {
      const result = input.doneEvent.result as {
        signal?: string;
        confidence?: string;
        structuredJson?: { dataAsOf?: string } | null;
      };
      return {
        overallSignal: result.signal,
        overallConfidence: result.confidence,
        dataAsOf: result.structuredJson?.dataAsOf ?? input.todayDate,
      };
    }

    const summaryRow =
      input.summaryJson !== null
        ? (input.summaryJson as {
            overallSignal?: string;
            overallConfidence?: string;
          })
        : null;
    return {
      overallSignal: summaryRow?.overallSignal,
      overallConfidence: summaryRow?.overallConfidence,
      dataAsOf: input.summaryDataAsOf ?? undefined,
    };
  }

  private pickSectionFields(
    event: Extract<SseEvent, { type: 'section_complete' }>,
    accumulator: AnalysisSectionAccumulator,
  ) {
    const structured =
      accumulator.structuredJson && typeof accumulator.structuredJson === 'object'
        ? (accumulator.structuredJson as {
            conclusion?: {
              signal?: string;
              confidence?: string;
            };
          })
        : null;
    const signal = structured?.conclusion?.signal;
    const confidence = structured?.conclusion?.confidence;

    return {
      ...(typeof event.usage?.tokensIn === 'number'
        ? { tokensIn: event.usage.tokensIn }
        : {}),
      ...(typeof event.usage?.tokensOut === 'number'
        ? { tokensOut: event.usage.tokensOut }
        : {}),
      ...(typeof event.usage?.durationMs === 'number'
        ? { durationMs: Math.round(event.usage.durationMs) }
        : {}),
      ...(signal && isSignal(signal) ? { signal: toPrismaSignal(signal) } : {}),
      ...(confidence && isConfidence(confidence)
        ? { confidence: toPrismaConfidence(confidence) }
        : {}),
    };
  }

  private orphanStatusFor(status: AnalysisTerminalStatus): PrismaAnalysisStatus {
    if (status === 'CANCELLED') return PrismaAnalysisStatus.CANCELLED;
    if (status === 'BUDGET_EXHAUSTED') {
      return PrismaAnalysisStatus.BUDGET_EXHAUSTED;
    }
    return PrismaAnalysisStatus.FAILED;
  }

  private orphanMessageFor(status: AnalysisTerminalStatus) {
    if (status === 'CANCELLED') {
      return 'Run cancelled before this section completed';
    }
    if (status === 'BUDGET_EXHAUSTED') {
      return 'Run budget exhausted before this section completed';
    }
    return 'Run failed before this section completed';
  }
}
