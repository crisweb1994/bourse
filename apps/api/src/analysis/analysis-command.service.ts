import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { SCHEMA_VERSION } from '@bourse/analysis';
import {
  COMPREHENSIVE_DIMENSIONS,
  isSectionType,
} from '@bourse/shared-types';
import {
  AnalysisStatus as PrismaAnalysisStatus,
  AnalysisType as PrismaAnalysisType,
  Prisma,
  SectionType as PrismaSectionType,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateAnalysisDto } from './analysis.dto';
import { ProviderResolverService } from './provider-resolver.service';

@Injectable()
export class AnalysisCommandService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly providerResolver: ProviderResolverService,
  ) {}

  async create(userId: string, dto: CreateAnalysisDto) {
    const stock = await this.prisma.stock.findUnique({
      where: { id: dto.stockId },
    });
    if (!stock) throw new NotFoundException('Stock not found');

    const { aiModel, providerName, settingId } =
      await this.providerResolver.resolveProvider(userId, {
        settingIdHint: dto.aiProviderSettingId,
        providerNameHint: dto.aiProvider,
        modelHint: dto.aiModel,
      });

    const isComprehensive = dto.analysisType === 'COMPREHENSIVE';
    const sections = isComprehensive
      ? COMPREHENSIVE_DIMENSIONS.map((type, order) => ({
          type: PrismaSectionType[type],
          order,
        }))
      : [
          {
            type: this.sectionTypeForSingleAnalysis(dto.analysisType),
            order: 0,
          },
        ];

    return this.prisma.analysis.create({
      data: {
        userId,
        stockId: stock.id,
        symbol: stock.symbol,
        market: stock.market,
        analysisType: PrismaAnalysisType[dto.analysisType],
        aiProvider: providerName,
        aiModel,
        aiProviderSettingId: settingId,
        promptVersion: SCHEMA_VERSION,
        sections: { create: sections },
      },
      include: { sections: { orderBy: { order: 'asc' } }, stock: true },
    });
  }

  async delete(userId: string, id: string) {
    const analysis = await this.prisma.analysis.findFirst({
      where: { id, userId },
      select: { id: true },
    });
    if (!analysis) throw new NotFoundException('Analysis not found');

    await this.prisma.analysis.delete({ where: { id } });
    return { ok: true };
  }

  async abort(userId: string, id: string) {
    const analysis = await this.prisma.analysis.findFirst({
      where: { id, userId },
      include: { sections: true },
    });
    if (!analysis) throw new NotFoundException('Analysis not found');

    if (
      analysis.status !== PrismaAnalysisStatus.PENDING &&
      analysis.status !== PrismaAnalysisStatus.IN_PROGRESS
    ) {
      throw new ForbiddenException(
        'Only PENDING or IN_PROGRESS analyses can be aborted',
      );
    }

    await this.prisma.analysisSection.updateMany({
      where: {
        analysisId: id,
        status: {
          in: [
            PrismaAnalysisStatus.PENDING,
            PrismaAnalysisStatus.IN_PROGRESS,
          ],
        },
      },
      data: {
        status: PrismaAnalysisStatus.CANCELLED,
        errorMessage: 'Manually cancelled by user',
      },
    });
    await this.prisma.analysis.update({
      where: { id },
      data: { status: PrismaAnalysisStatus.CANCELLED },
    });

    return { ok: true };
  }

  async retrySection(userId: string, analysisId: string, sectionId: string) {
    const analysis = await this.prisma.analysis.findFirst({
      where: { id: analysisId, userId },
      include: { sections: true },
    });
    if (!analysis) throw new NotFoundException('Analysis not found');

    const section = analysis.sections.find((item) => item.id === sectionId);
    if (!section) throw new NotFoundException('Section not found');

    if (section.status !== PrismaAnalysisStatus.FAILED) {
      throw new Error('Only FAILED sections can be retried');
    }

    await this.prisma.analysisSection.update({
      where: { id: sectionId },
      data: {
        status: PrismaAnalysisStatus.PENDING,
        reportMarkdown: null,
        structuredJson: Prisma.JsonNull,
        citations: Prisma.JsonNull,
        errorMessage: null,
      },
    });
    await this.prisma.analysis.update({
      where: { id: analysisId },
      data: { status: PrismaAnalysisStatus.PENDING },
    });

    return { ok: true };
  }

  private sectionTypeForSingleAnalysis(
    analysisType: CreateAnalysisDto['analysisType'],
  ) {
    if (!isSectionType(analysisType)) {
      throw new Error(`Analysis type ${analysisType} has no section type`);
    }
    return PrismaSectionType[analysisType];
  }
}
