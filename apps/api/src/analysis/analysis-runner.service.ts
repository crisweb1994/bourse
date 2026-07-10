import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  isTerminalAnalysisStatus,
  type AnalysisStatus,
  type SectionType,
} from '@bourse/shared-types';
import { ToolCacheService } from '../lifecycle/tool-cache.service';
import { PrismaService } from '../prisma/prisma.service';
import { parseAnalysisConcurrency } from './concurrency';
import { AnalysisReplayService } from './analysis-replay.service';
import { EvidencePackService } from './evidence-pack.service';
import { ProviderResolverService } from './provider-resolver.service';
import { runStreamComprehensiveAdapter } from './stream-comprehensive-adapter';
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
 * the apps/api glue that claims the row and resolves the provider pair. The
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
    private toolCache: ToolCacheService,
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
      fallback: fallbackProvider,
      aiModel,
    } = await this.providerResolver.resolveProviderPair(analysis.userId, {
      settingIdHint: analysis.aiProviderSettingId,
      providerNameHint: analysis.aiProvider,
      modelHint: analysis.aiModel,
      market: analysis.market,
    });
    // Web_search recovery is always enabled for production runs. It only
    // fires when the structured fetch yields no usable data (no pack / missing
    // financials), where it's the sole path to a non-empty result.
    const allowWebSearchFallback = true;
    const tag = this.logTag(analysisId);

    // B1 step 3: the adapter (packages/analysis streamComprehensive /
    // streamSingle) is the single orchestration path for ALL analyses —
    // comprehensive → all dims + summary, single → one dim via streamSingle,
    // every market. The legacy hand-rolled path and its feature flag are gone.
    const mode = isComprehensive ? 'comprehensive' : 'single';
    this.logger.log(`${tag} adapter path engaged (mode=${mode})`);
    try {
      await runStreamComprehensiveAdapter({
        mode,
        analysisId,
        analysis,
        provider,
        send,
        prisma: this.prisma,
        toolCache: this.toolCache,
        evidencePackService: this.evidencePackService,
        modelId: aiModel,
        providerName: analysis.aiProvider || 'claude',
        waveSemaphore: parseAnalysisConcurrency(
          this.config.get('ANALYSIS_PARALLEL_CONCURRENCY'),
        ),
        ...(allowWebSearchFallback ? { allowWebSearchFallback: true } : {}),
        ...(fallbackProvider ? { fallbackProvider } : {}),
      });
    } catch (err) {
      // The adapter already writes terminal Analysis state + sends `done`
      // on its own error branch; this catch is a last-resort safety net
      // for unexpected throws outside the adapter's try/catch.
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`${tag} adapter unexpected throw: ${msg}`);
    }
  }

  private logTag(analysisId: string, sectionType?: string) {
    const short = analysisId.slice(-8);
    return sectionType ? `[${short}][${sectionType}]` : `[${short}]`;
  }
}
