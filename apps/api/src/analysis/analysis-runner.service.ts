import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ToolCacheService } from '../lifecycle/tool-cache.service';
import { PrismaService } from '../prisma/prisma.service';
import { parseAnalysisConcurrency } from './concurrency';
import { ProviderResolverService } from './provider-resolver.service';
import { runStreamComprehensiveAdapter } from './stream-comprehensive-adapter';
import { SnapshotV2Service } from './snapshot-v2.service';
import type { SseCallback } from './types';

/**
 * SSE run loop: drives the analysis from PENDING → IN_PROGRESS → terminal,
 * and replays stored state on reconnect (terminal replay + in-progress
 * snapshot). The actual dim/summary orchestration lives in
 * `@bourse/analysis` (streamComprehensive/streamSingle); this service is
 * the apps/api glue that claims the row, resolves the provider pair, and
 * translates the adapter's SSE events into DB writes.
 *
 * Reads analysis rows straight from prisma (NOT via AnalysisService) — the
 * claim + status-machine writes are run-loop internals, not CRUD. Injecting
 * AnalysisService would create a Runner ↔ Service cycle.
 */
@Injectable()
export class AnalysisRunnerService {
  private readonly logger = new Logger(AnalysisRunnerService.name);

  constructor(
    private prisma: PrismaService,
    private providerResolver: ProviderResolverService,
    private config: ConfigService,
    private toolCache: ToolCacheService,
    private snapshotV2: SnapshotV2Service,
  ) {}

  async runAnalysis(analysisId: string, send: SseCallback) {
    let analysis = await this.prisma.analysis.findUnique({
      where: { id: analysisId },
      include: { sections: { orderBy: { order: 'asc' } }, stock: true },
    });

    if (!analysis) {
      send('error', { message: 'Analysis not found' });
      return;
    }

    // Replay terminal states instead of rerunning and charging again.
    if (['COMPLETED', 'PARTIAL_FAILED', 'FAILED', 'CANCELLED'].includes(analysis.status)) {
      this.replayCompleted(analysis, send);
      return;
    }

    if (analysis.status === 'IN_PROGRESS') {
      // Mid-stream attach: emit a snapshot of current section progress so
      // the polling client (use-analysis-stream.ts) can render real state
      // instead of an empty "正在初始化分析…" loader on every 3s retry.
      // The `error: already running` below still tells the client to keep
      // polling — each retry refreshes with newer progress.
      this.replayInProgress(analysis, send);
      send('error', { message: 'Analysis is already running' });
      return;
    }

    // Claim
    const claimed = await this.prisma.analysis.updateMany({
      where: { id: analysisId, status: { in: ['PENDING', 'FAILED'] } },
      data: { status: 'IN_PROGRESS' },
    });

    if (claimed.count === 0) {
      analysis = await this.prisma.analysis.findUnique({
        where: { id: analysisId },
        include: { sections: { orderBy: { order: 'asc' } }, stock: true },
      });
      if (analysis?.status === 'COMPLETED') {
        this.replayCompleted(analysis, send);
        return;
      }
      send('error', { message: 'Analysis cannot be started in its current state' });
      return;
    }

    const isComprehensive = analysis.analysisType === 'COMPREHENSIVE';
    const {
      primary: provider,
      fallback: fallbackProvider,
      aiModel,
    } = await this.providerResolver.resolveProviderPair(analysis.userId, {
      settingIdHint: (analysis as any).aiProviderSettingId,
      providerNameHint: analysis.aiProvider,
      modelHint: analysis.aiModel,
      market: analysis.market,
    });
    // Web_search recovery is now always enabled for production runs: it only
    // fires when the structured fetch yields no usable data (no pack / missing
    // financials), where it's the sole path to a non-empty result. The former
    // per-user opt-in (User.allowWebSearchFallback) is obsolete — the column +
    // AI-Settings toggle are pending removal.
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
        snapshotV2: this.snapshotV2,
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

  /**
   * Replay state of a still-running analysis: emit section_start (+
   * any partial reportMarkdown) for every section, and section_complete
   * only for those that already reached a terminal status. Sends no
   * summary and no `done` event — those wait for the live run to finish.
   * Caller is expected to follow up with `error: already running` so the
   * client knows to keep polling.
   */
  private replayInProgress(analysis: any, send: SseCallback) {
    for (const section of analysis.sections) {
      send('section_start', {
        sectionType: section.type,
        sectionId: section.id,
        order: section.order,
      });
      if (section.reportMarkdown) {
        send('report_chunk', {
          text: section.reportMarkdown,
          sectionType: section.type,
        });
      }
      const terminal =
        section.status === 'COMPLETED' || section.status === 'FAILED';
      if (!terminal) continue;
      const citations = Array.isArray(section.citations)
        ? section.citations
        : [];
      for (const citation of citations) {
        send('citation', {
          title: citation.title,
          url: citation.url,
          claim: citation.claim || '',
          sectionType: section.type,
        });
      }
      if (section.structuredJson) {
        send('structured_data', {
          json: section.structuredJson,
          sectionType: section.type,
        });
      }
      send('section_complete', {
        sectionType: section.type,
        status: section.status,
        error: section.errorMessage ?? null,
      });
    }
  }

  private replayCompleted(analysis: any, send: SseCallback) {
    for (const section of analysis.sections) {
      this.replaySection(section, send);
    }

    // Replay summary for COMPREHENSIVE
    if (analysis.analysisType === 'COMPREHENSIVE' && analysis.summaryMarkdown) {
      send('summary_chunk', { text: analysis.summaryMarkdown });
      send('report_complete', { sectionType: 'COMPREHENSIVE' });
      if (analysis.summaryJson) {
        send('summary_complete', { summaryJson: analysis.summaryJson });
      }
    }

    send('done', { analysisId: analysis.id });
  }

  private replaySection(section: any, send: SseCallback) {
    send('section_start', { sectionType: section.type, sectionId: section.id, order: section.order });

    if (section.reportMarkdown) {
      send('report_chunk', { text: section.reportMarkdown, sectionType: section.type });
    }
    send('report_complete', { sectionType: section.type });

    const citations = Array.isArray(section.citations) ? section.citations : [];
    for (const citation of citations) {
      send('citation', {
        title: citation.title,
        url: citation.url,
        claim: citation.claim || '',
        sectionType: section.type,
      });
    }

    if (section.structuredJson) {
      send('structured_data', { json: section.structuredJson, sectionType: section.type });
    }

    send('section_complete', {
      sectionType: section.type,
      status: section.status,
      error: section.errorMessage ?? null,
    });
  }

  private logTag(analysisId: string, sectionType?: string) {
    const short = analysisId.slice(-8);
    return sectionType ? `[${short}][${sectionType}]` : `[${short}]`;
  }
}
