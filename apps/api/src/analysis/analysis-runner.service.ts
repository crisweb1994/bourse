import { Injectable, Logger } from '@nestjs/common';
import {
  isTerminalAnalysisStatus,
  type AnalysisMode,
  type AnalysisStatus,
  type FocusWindow,
  type SectionStatus,
  type SectionType,
} from '@bourse/shared-types';
import {
  AnalysisStatus as PrismaAnalysisStatus,
  FocusWindow as PrismaFocusWindow,
  SectionStatus as PrismaSectionStatus,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AnalysisReplayService } from './analysis-replay.service';
import { AnalysisRunRegistry } from './analysis-run-registry.service';
import { EvidencePackService } from './evidence-pack.service';
import { ProviderResolverService } from './provider-resolver.service';
import { runAnalysisWorkflowAdapter } from './analysis-workflow-adapter';
import type { AnalysisSseCallback } from './analysis-sse.contract';

const FOCUS_WINDOW_FROM_PRISMA: Record<PrismaFocusWindow, FocusWindow> = {
  [PrismaFocusWindow.D30]: '30D',
  [PrismaFocusWindow.D90]: '90D',
  [PrismaFocusWindow.Y1]: '1Y',
  [PrismaFocusWindow.Y3]: '3Y',
};

interface AnalysisRunSection {
  id: string;
  type: SectionType;
  order: number;
  status: SectionStatus;
  reportMarkdown?: string | null;
  structuredJson?: unknown;
  errorMessage?: string | null;
}

interface AnalysisRun {
  id: string;
  symbol: string;
  userId: string;
  mode: AnalysisMode;
  focusWindow: FocusWindow;
  question?: string | null;
  status: AnalysisStatus;
  aiProvider?: string | null;
  aiModel?: string | null;
  aiProviderSettingId?: string | null;
  market: string;
  summaryMarkdown?: string | null;
  summaryJson?: unknown;
  sections: AnalysisRunSection[];
  evidenceSnapshot?: {
    capturedAt: Date;
    dataAsOf: unknown;
    degraded: boolean;
    missingFields: string[];
    sourceMode: string;
  } | null;
  stock: { symbol: string; market: string; name?: string | null };
}

@Injectable()
export class AnalysisRunnerService {
  private readonly logger = new Logger(AnalysisRunnerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly providerResolver: ProviderResolverService,
    private readonly evidencePackService: EvidencePackService,
    private readonly replayService: AnalysisReplayService,
    private readonly runRegistry: AnalysisRunRegistry,
  ) {}

  async runAnalysis(analysisId: string, send: AnalysisSseCallback) {
    const analysis = await this.loadAnalysis(analysisId);
    if (!analysis) {
      send('error', { message: 'Analysis not found' });
      return;
    }

    if (isTerminalAnalysisStatus(analysis.status)) {
      this.replayService.replayTerminalRun(analysis, send);
      return;
    }

    if (analysis.status === 'IN_PROGRESS') {
      this.replayService.replayInProgressRun(analysis, send);
      if (this.runRegistry.subscribe(analysisId, send)) {
        await this.runRegistry.wait(analysisId);
      } else {
        await this.markInterrupted(analysisId);
        send('done', { analysisId, status: 'FAILED' });
      }
      return;
    }

    await this.startPendingRun(analysisId, analysis, send);
  }

  private async loadAnalysis(analysisId: string): Promise<AnalysisRun | null> {
    const row = await this.prisma.analysis.findUnique({
      where: { id: analysisId },
      include: {
        sections: { orderBy: { order: 'asc' } },
        stock: true,
        evidenceSnapshot: {
          select: {
            capturedAt: true,
            dataAsOf: true,
            degraded: true,
            missingFields: true,
            sourceMode: true,
          },
        },
      },
    });
    if (!row) return null;
    return {
      ...row,
      mode: row.mode as AnalysisMode,
      focusWindow: FOCUS_WINDOW_FROM_PRISMA[row.focusWindow],
      status: row.status as AnalysisStatus,
      market: row.market,
      sections: row.sections.map((section) => ({
        ...section,
        type: section.type as SectionType,
        status: section.status as SectionStatus,
      })),
      evidenceSnapshot: row.evidenceSnapshot,
      stock: row.stock,
    };
  }

  private async startPendingRun(
    analysisId: string,
    analysis: AnalysisRun,
    firstSubscriber: AnalysisSseCallback,
  ) {
    const claimed = await this.prisma.analysis.updateMany({
      where: { id: analysisId, status: 'PENDING' },
      data: { status: 'IN_PROGRESS', startedAt: new Date(), errorCode: null, errorMessage: null },
    });
    if (claimed.count === 0) {
      const latest = await this.loadAnalysis(analysisId);
      if (latest && isTerminalAnalysisStatus(latest.status)) {
        this.replayService.replayTerminalRun(latest, firstSubscriber);
      } else {
        firstSubscriber('error', { message: 'Analysis cannot be started in its current state' });
      }
      return;
    }

    const abortController = new AbortController();
    this.runRegistry.register(analysisId, abortController);
    this.runRegistry.subscribe(analysisId, firstSubscriber);
    const send: AnalysisSseCallback = (event, data) => {
      this.runRegistry.broadcast(analysisId, event, data);
    };

    try {
      const { primary: provider, aiModel } =
        await this.providerResolver.resolveWorkflowProvider(analysis.userId, {
          settingIdHint: analysis.aiProviderSettingId,
          providerNameHint: analysis.aiProvider,
          modelHint: analysis.aiModel,
        });
      if (abortController.signal.aborted) {
        const settled = await this.settleUnexpectedRun(
          analysisId,
          'CANCELLED',
          'Cancelled by user',
          'CANCELLED_BY_USER',
        );
        if (settled) send('done', { analysisId, status: 'CANCELLED' });
        return;
      }
      const current = await this.prisma.analysis.findUnique({
        where: { id: analysisId },
        select: { status: true },
      });
      if (current?.status !== 'IN_PROGRESS') {
        send('done', { analysisId, status: current?.status as AnalysisStatus });
        return;
      }
      this.logger.log(`[${analysisId.slice(-8)}] starting ${analysis.mode} workflow`);
      await runAnalysisWorkflowAdapter({
        analysisId,
        analysis,
        provider,
        send,
        prisma: this.prisma,
        evidencePackService: this.evidencePackService,
        aiModel,
        mode: analysis.mode,
        focusWindow: analysis.focusWindow,
        // Keep independent modules bounded while allowing QUICK to overlap
        // provider latency. Two concurrent calls fit the current gateway;
        // sequential execution remains available to workflow tests.
        waveSemaphore: 2,
        signal: abortController.signal,
      });
    } catch (error) {
      const aborted = abortController.signal.aborted ||
        (error instanceof Error && error.name === 'AbortError');
      const status = aborted ? 'CANCELLED' : 'FAILED';
      const settled = await this.settleUnexpectedRun(
        analysisId,
        status,
        aborted ? 'Cancelled by user' : error instanceof Error ? error.message : String(error),
        aborted ? 'CANCELLED_BY_USER' : 'PROVIDER_RESOLVE_FAILED',
      );
      // The adapter normally persists and emits its own terminal event. Only
      // emit here when the failure happened before the adapter could do so.
      if (settled) {
        if (!aborted) {
          send('error', {
            message: error instanceof Error ? error.message : String(error),
          });
        }
        send('done', { analysisId, status });
      }
    } finally {
      this.runRegistry.release(analysisId);
    }
  }

  private async settleUnexpectedRun(
    analysisId: string,
    status: 'FAILED' | 'CANCELLED',
    message: string,
    errorCode: string,
  ): Promise<boolean> {
    const now = new Date();
    const updated = await this.prisma.analysis.updateMany({
      where: {
        id: analysisId,
        status: PrismaAnalysisStatus.IN_PROGRESS,
      },
      data: {
        status: status === 'CANCELLED'
          ? PrismaAnalysisStatus.CANCELLED
          : PrismaAnalysisStatus.FAILED,
        errorCode,
        errorMessage: message,
        completedAt: now,
      },
    });
    if (updated.count === 0) return false;

    await this.prisma.analysisSection.updateMany({
      where: {
        analysisId,
        status: {
          in: [PrismaSectionStatus.PENDING, PrismaSectionStatus.IN_PROGRESS],
        },
      },
      data: {
        status: status === 'CANCELLED'
          ? PrismaSectionStatus.CANCELLED
          : PrismaSectionStatus.FAILED,
        errorCode,
        errorMessage: message,
        completedAt: now,
      },
    });
    return true;
  }

  private async markInterrupted(analysisId: string) {
    await this.prisma.analysis.updateMany({
      where: { id: analysisId, status: 'IN_PROGRESS' },
      data: {
        status: 'FAILED',
        errorCode: 'PROCESS_INTERRUPTED',
        errorMessage: 'Analysis process was interrupted',
        completedAt: new Date(),
      },
    });
    await this.prisma.analysisSection.updateMany({
      where: {
        analysisId,
        status: { in: [PrismaSectionStatus.PENDING, PrismaSectionStatus.IN_PROGRESS] },
      },
      data: {
        status: PrismaSectionStatus.FAILED,
        errorCode: 'PROCESS_INTERRUPTED',
        errorMessage: 'Analysis process was interrupted',
        completedAt: new Date(),
      },
    });
  }
}
