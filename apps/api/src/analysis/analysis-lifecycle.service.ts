import {
  Injectable,
  Logger,
  OnModuleInit,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Analysis lifecycle: startup orphan reclaim + user-driven abort/retry.
 * These are all "state-machine writes" (updateMany/update on Analysis +
 * AnalysisSection), distinct from CRUD reads and from the SSE run loop.
 *
 * Implements OnModuleInit so NestJS auto-calls the orphan reclaim on boot —
 * no upper layer needs to wire it. Does NOT inject AnalysisService (avoids a
 * cycle): abort/retry talk to prisma directly, the same way the orphan
 * reclaim does.
 */
@Injectable()
export class AnalysisLifecycleService implements OnModuleInit {
  private readonly logger = new Logger(AnalysisLifecycleService.name);

  constructor(private prisma: PrismaService) {}

  async onModuleInit() {
    // Mark any IN_PROGRESS records orphaned by a previous server restart as FAILED.
    const orphanAnalyses = await this.prisma.analysis.updateMany({
      where: { status: 'IN_PROGRESS' as any },
      data: { status: 'FAILED' as any },
    });
    const orphanSections = await this.prisma.analysisSection.updateMany({
      where: { status: { in: ['IN_PROGRESS', 'PENDING'] } as any, analysis: { status: 'FAILED' } },
      data: { status: 'FAILED' as any, errorMessage: 'Server restarted while running' },
    });
    if (orphanAnalyses.count > 0 || orphanSections.count > 0) {
      this.logger.warn(
        `Reclaimed ${orphanAnalyses.count} orphan analyses and ${orphanSections.count} sections from previous run`,
      );
    }
  }

  async abort(userId: string, id: string) {
    const analysis = await this.prisma.analysis.findFirst({
      where: { id, userId },
      include: { sections: true },
    });
    if (!analysis) throw new NotFoundException('Analysis not found');

    if (!['PENDING', 'IN_PROGRESS'].includes(analysis.status)) {
      throw new ForbiddenException('Only PENDING or IN_PROGRESS analyses can be aborted');
    }

    await this.prisma.analysisSection.updateMany({
      where: { analysisId: id, status: { in: ['PENDING', 'IN_PROGRESS'] } as any },
      data: { status: 'FAILED' as any, errorMessage: 'Manually aborted by user (suspected stuck)' },
    });
    await this.prisma.analysis.update({
      where: { id },
      data: { status: 'FAILED' as any },
    });

    return { ok: true };
  }

  async retrySection(userId: string, analysisId: string, sectionId: string) {
    const analysis = await this.prisma.analysis.findFirst({
      where: { id: analysisId, userId },
      include: { sections: true },
    });
    if (!analysis) throw new NotFoundException('Analysis not found');

    const section = analysis.sections.find((s) => s.id === sectionId);
    if (!section) throw new NotFoundException('Section not found');

    if (section.status !== 'FAILED') {
      throw new Error('Only FAILED sections can be retried');
    }

    // Reset section and analysis status
    await this.prisma.analysisSection.update({
      where: { id: sectionId },
      data: {
        status: 'PENDING',
        reportMarkdown: null,
        structuredJson: null as any,
        citations: null as any,
        errorMessage: null,
      },
    });
    await this.prisma.analysis.update({
      where: { id: analysisId },
      data: { status: 'PENDING' },
    });

    return { ok: true };
  }
}
