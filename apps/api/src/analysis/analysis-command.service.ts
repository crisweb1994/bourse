import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AnalysisMode as PrismaAnalysisMode,
  AnalysisStatus as PrismaAnalysisStatus,
  FocusWindow as PrismaFocusWindow,
  Prisma,
  SectionStatus as PrismaSectionStatus,
  SectionType as PrismaSectionType,
} from '@prisma/client';
import { SECTION_ORDER } from '@bourse/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import { CreateAnalysisDto } from './analysis.dto';
import { AnalysisRunRegistry } from './analysis-run-registry.service';
import { mapAnalysisDto } from './analysis-query.service';
import { ProviderResolverService } from './provider-resolver.service';

const FOCUS_WINDOW_TO_PRISMA: Record<string, PrismaFocusWindow> = {
  '30D': PrismaFocusWindow.D30,
  '90D': PrismaFocusWindow.D90,
  '1Y': PrismaFocusWindow.Y1,
  '3Y': PrismaFocusWindow.Y3,
};

@Injectable()
export class AnalysisCommandService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly providerResolver: ProviderResolverService,
    private readonly runRegistry: AnalysisRunRegistry,
  ) {}

  async create(userId: string, dto: CreateAnalysisDto) {
    const stock = await this.prisma.stock.findUnique({
      where: { id: dto.stockId },
    });
    if (!stock) throw new NotFoundException('Stock not found');

    const ongoing = await this.prisma.analysis.findFirst({
      where: {
        userId,
        stockId: stock.id,
        status: { in: [PrismaAnalysisStatus.PENDING, PrismaAnalysisStatus.IN_PROGRESS] },
      },
      select: { id: true },
    });
    if (ongoing) {
      throw new ConflictException('An analysis for this stock is already running');
    }

    const { aiModel, providerName, settingId } =
      await this.providerResolver.resolveAnalysisMetadata(userId, {
        settingIdHint: dto.aiProviderSettingId,
        modelHint: dto.aiModel,
      });

    const mode = dto.mode as PrismaAnalysisMode;
    const focusWindow = FOCUS_WINDOW_TO_PRISMA[dto.focusWindow ?? '90D'];
    if (!focusWindow) throw new Error('Invalid focus window');

    const created = await this.prisma.analysis.create({
      data: {
        userId,
        stockId: stock.id,
        symbol: stock.symbol,
        mode,
        focusWindow,
        question: dto.question?.trim() || null,
        aiProvider: providerName,
        aiModel,
        aiProviderSettingId: settingId,
        sections: {
          create: SECTION_ORDER.map((type, order) => ({
            type: PrismaSectionType[type],
            order,
          })),
        },
      },
      include: { sections: { orderBy: { order: 'asc' } }, stock: true },
    });
    return mapAnalysisDto(created);
  }

  async delete(userId: string, id: string) {
    const analysis = await this.prisma.analysis.findFirst({
      where: { id, userId },
      select: { id: true, status: true },
    });
    if (!analysis) throw new NotFoundException('Analysis not found');
    if (
      analysis.status === PrismaAnalysisStatus.PENDING ||
      analysis.status === PrismaAnalysisStatus.IN_PROGRESS
    ) {
      throw new ConflictException('Cancel the running analysis before deleting it');
    }

    await this.prisma.analysis.delete({ where: { id } });
    return { ok: true };
  }

  async abort(userId: string, id: string) {
    const analysis = await this.prisma.analysis.findFirst({
      where: { id, userId },
      select: { id: true, status: true },
    });
    if (!analysis) throw new NotFoundException('Analysis not found');

    if (
      analysis.status !== PrismaAnalysisStatus.PENDING &&
      analysis.status !== PrismaAnalysisStatus.IN_PROGRESS
    ) {
      throw new ForbiddenException(
        'Only PENDING or IN_PROGRESS analyses can be cancelled',
      );
    }

    const now = new Date();
    await this.prisma.$transaction([
      this.prisma.analysisSection.updateMany({
        where: {
          analysisId: id,
          analysis: {
            status: {
              in: [PrismaAnalysisStatus.PENDING, PrismaAnalysisStatus.IN_PROGRESS],
            },
          },
          status: {
            in: [PrismaSectionStatus.PENDING, PrismaSectionStatus.IN_PROGRESS],
          },
        },
        data: {
          status: PrismaSectionStatus.CANCELLED,
          errorCode: 'CANCELLED_BY_USER',
          errorMessage: 'Manually cancelled by user',
          completedAt: now,
        },
      }),
      this.prisma.analysis.updateMany({
        where: {
          id,
          status: {
            in: [PrismaAnalysisStatus.PENDING, PrismaAnalysisStatus.IN_PROGRESS],
          },
        },
        data: {
          status: PrismaAnalysisStatus.CANCELLED,
          errorCode: 'CANCELLED_BY_USER',
          errorMessage: 'Manually cancelled by user',
          completedAt: now,
        },
      }),
    ]);
    // Mark the database first. The workflow's terminal writes are guarded by
    // `status = IN_PROGRESS`, so once cancellation wins the race they cannot
    // turn the run back into PARTIAL_FAILED/COMPLETED. Abort the provider only
    // after that durable state transition is visible.
    this.runRegistry.abort(id);

    return { ok: true };
  }

  async retry(userId: string, analysisId: string) {
    const analysis = await this.prisma.analysis.findFirst({
      where: { id: analysisId, userId },
      include: { sections: true, evidenceSnapshot: true },
    });
    if (!analysis) throw new NotFoundException('Analysis not found');
    if (!['FAILED', 'PARTIAL_FAILED'].includes(analysis.status)) {
      throw new ConflictException('Only failed analyses can be retried');
    }
    if (!analysis.evidenceSnapshot) {
      throw new ConflictException('This analysis has no evidence snapshot; create a new analysis');
    }

    const factTypes = new Set([
      'COMPANY_QUALITY',
      'INDUSTRY_POSITION',
      'VALUATION_SCENARIOS',
      'MARKET_SIGNALS',
    ]);
    // A SKIPPED section is a deterministic data-availability outcome of the
    // immutable snapshot: re-running it on the same snapshot skips again and
    // only burns a summary regeneration. Retrying must target real failures.
    const failedSections = analysis.sections.filter(
      (section) => section.status === PrismaSectionStatus.FAILED,
    );
    const summaryFailed =
      analysis.status === PrismaAnalysisStatus.PARTIAL_FAILED &&
      !analysis.summaryMarkdown &&
      analysis.summaryJson === null;
    if (failedSections.length === 0 && !summaryFailed) {
      throw new ConflictException(
        'No failed sections to retry; skipped modules need a new analysis with a fresh evidence snapshot',
      );
    }
    const retryingFact = failedSections.some((section) =>
      factTypes.has(section.type),
    );

    await this.prisma.$transaction(async (tx) => {
      await tx.analysisSection.updateMany({
        where: {
          analysisId,
          status: PrismaSectionStatus.FAILED,
        },
        data: {
          status: PrismaSectionStatus.PENDING,
          reportMarkdown: null,
          structuredJson: Prisma.JsonNull,
          errorCode: null,
          errorMessage: null,
          startedAt: null,
          completedAt: null,
        },
      });

      if (retryingFact) {
        await tx.analysisSection.updateMany({
          where: { analysisId, type: PrismaSectionType.RISK_REGISTER },
          data: {
            status: PrismaSectionStatus.PENDING,
            reportMarkdown: null,
            structuredJson: Prisma.JsonNull,
            errorCode: null,
            errorMessage: null,
            startedAt: null,
            completedAt: null,
          },
        });
      }

      await tx.analysis.update({
        where: { id: analysisId },
        data: {
          status: PrismaAnalysisStatus.PENDING,
          summaryMarkdown: null,
          summaryJson: Prisma.JsonNull,
          overallSignal: null,
          overallConfidence: null,
          errorCode: null,
          errorMessage: null,
          startedAt: null,
          completedAt: null,
        },
      });
    });

    return { ok: true };
  }
}
