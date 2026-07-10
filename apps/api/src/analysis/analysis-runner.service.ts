import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  isTerminalAnalysisStatus,
  type AnalysisStatus,
  type SectionType,
} from '@bourse/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import { parseAnalysisConcurrency } from './concurrency';
import { AnalysisReplayService } from './analysis-replay.service';
import { EvidencePackService } from './evidence-pack.service';
import { ProviderResolverService } from './provider-resolver.service';
import { runAnalysisWorkflowAdapter } from './analysis-workflow-adapter';
import type { SseCallback } from './types';

interface AnalysisRunSection {
  id: string;
  type: SectionType;
  order: number;
  status: AnalysisStatus;
  reportMarkdown?: string | null;
  structuredJson?: unknown;
  citations?: unknown;
  errorMessage?: string | null;
}

interface AnalysisRun {
  id: string;
  symbol: string;
  userId: string;
  analysisType: string;
  status: AnalysisStatus;
  aiProvider?: string | null;
  aiModel?: string | null;
  aiProviderSettingId?: string | null;
  market: string;
  summaryMarkdown?: string | null;
  summaryJson?: unknown;
  sections: AnalysisRunSection[];
  stock: {
    symbol: string;
    market: string;
    name?: string | null;
  };
}

/**
 * SSE run loop: drives the analysis from PENDING → IN_PROGRESS → terminal.
 * The actual dim/summary orchestration lives in
 * `@bourse/analysis` (streamComprehensive/streamSingle); this service is
 * the apps/api glue that claims the row and resolves the workflow provider. The
 * adapter translates workflow events into API SSE events and persistence.
 *
 * Reads analysis rows straight from prisma (not via query/command services)
 * because claim + status-machine writes are run-loop internals, not CRUD.
 */
@Injectable()
export class AnalysisRunnerService {
  private readonly logger = new Logger(AnalysisRunnerService.name);

  constructor(
    private prisma: PrismaService,
    private providerResolver: ProviderResolverService,
    private config: ConfigService,
    private evidencePackService: EvidencePackService,
    private replayService: AnalysisReplayService,
  ) {}

  async runAnalysis(analysisId: string, send: SseCallback) {
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
      this.attachInProgressRun(analysis, send);
      return;
    }

    await this.startPendingRun(analysisId, analysis, send);
  }

  private loadAnalysis(analysisId: string): Promise<AnalysisRun | null> {
    return this.prisma.analysis.findUnique({
      where: { id: analysisId },
      include: { sections: { orderBy: { order: 'asc' } }, stock: true },
    });
  }

  private attachInProgressRun(analysis: AnalysisRun, send: SseCallback) {
    // Mid-stream attach: emit a snapshot of current section progress so
    // the polling client (use-analysis-stream.ts) can render real state
    // instead of an empty "正在初始化分析…" loader on every 3s retry.
    // The `error: already running` below still tells the client to keep
    // polling — each retry refreshes with newer progress.
    this.replayService.replayInProgressRun(analysis, send);
    send('error', { message: 'Analysis is already running' });
  }

  private async startPendingRun(
    analysisId: string,
    analysis: AnalysisRun,
    send: SseCallback,
  ) {
    const claimed = await this.prisma.analysis.updateMany({
      where: { id: analysisId, status: { in: ['PENDING', 'FAILED'] } },
      data: { status: 'IN_PROGRESS' },
    });

    if (claimed.count === 0) {
      const latest = await this.loadAnalysis(analysisId);
      if (latest && isTerminalAnalysisStatus(latest.status)) {
        this.replayService.replayTerminalRun(latest, send);
        return;
      }
      send('error', {
        message: 'Analysis cannot be started in its current state',
      });
      return;
    }

    const isComprehensive = analysis.analysisType === 'COMPREHENSIVE';
    const {
      primary: provider,
      aiModel,
    } = await this.providerResolver.resolveWorkflowProvider(analysis.userId, {
      settingIdHint: analysis.aiProviderSettingId,
      providerNameHint: analysis.aiProvider,
      modelHint: analysis.aiModel,
    });
    const tag = this.logTag(analysisId);

    const mode = isComprehensive ? 'comprehensive' : 'single';
    this.logger.log(`${tag} adapter path engaged (mode=${mode})`);
    await runAnalysisWorkflowAdapter({
      mode,
      analysisId,
      analysis,
      provider,
      send,
      prisma: this.prisma,
      evidencePackService: this.evidencePackService,
      modelId: aiModel,
      waveSemaphore: parseAnalysisConcurrency(
        this.config.get('ANALYSIS_PARALLEL_CONCURRENCY'),
      ),
    });
  }

  private logTag(analysisId: string, sectionType?: string) {
    const short = analysisId.slice(-8);
    return sectionType ? `[${short}][${sectionType}]` : `[${short}]`;
  }
}
