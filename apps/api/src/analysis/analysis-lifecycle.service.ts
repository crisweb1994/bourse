import {
  Injectable,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import {
  AnalysisStatus as PrismaAnalysisStatus,
  SectionStatus as PrismaSectionStatus,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Startup lifecycle hook. User-driven state-machine commands live in
 * AnalysisCommandService; this service only reclaims orphaned in-progress rows
 * after a server restart.
 */
@Injectable()
export class AnalysisLifecycleService implements OnModuleInit {
  private readonly logger = new Logger(AnalysisLifecycleService.name);

  constructor(private prisma: PrismaService) {}

  async onModuleInit() {
    // Mark any IN_PROGRESS records orphaned by a previous server restart as FAILED.
    const orphanAnalyses = await this.prisma.analysis.updateMany({
      where: { status: PrismaAnalysisStatus.IN_PROGRESS },
      data: { status: PrismaAnalysisStatus.FAILED },
    });
    const orphanSections = await this.prisma.analysisSection.updateMany({
      where: {
        status: {
          in: [
            PrismaSectionStatus.IN_PROGRESS,
            PrismaSectionStatus.PENDING,
          ],
        },
        analysis: { status: PrismaAnalysisStatus.FAILED },
      },
      data: {
        status: PrismaSectionStatus.FAILED,
        errorCode: 'PROCESS_INTERRUPTED',
        errorMessage: 'Server restarted while running',
        completedAt: new Date(),
      },
    });
    if (orphanAnalyses.count > 0 || orphanSections.count > 0) {
      this.logger.warn(
        `Reclaimed ${orphanAnalyses.count} orphan analyses and ${orphanSections.count} sections from previous run`,
      );
    }
  }
}
