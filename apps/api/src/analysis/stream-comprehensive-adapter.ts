import { Logger } from '@nestjs/common';
import type { AnalysisTerminalStatus } from '@bourse/shared-types';
import {
  type AgentProvider,
  type ComprehensiveOptions,
  type DimensionInput,
  getDimension,
  getMarket,
  type SseEvent,
  streamComprehensive,
  streamSingle,
} from '@bourse/analysis';
import type { ToolCacheService } from '../lifecycle/tool-cache.service';
import type { PrismaService } from '../prisma/prisma.service';
import {
  AnalysisPersistenceMapper,
  type AnalysisSectionAccumulator,
} from './analysis-persistence.mapper';
import {
  mapCitationEvent,
  mapDoneEvent,
  mapErrorEvent,
  mapEvidencePackReadyEvent,
  mapJudgeCompleteEvent,
  mapJudgeStartEvent,
  mapReportChunkEvent,
  mapReportCompleteEvent,
  mapSectionCompleteEvent,
  mapSectionSkippedEvent,
  mapSectionStartEvent,
  mapStructuredDataEvent,
  mapSummaryChunkEvent,
  mapSummaryCompleteEvent,
  mapThrownError,
  mapWebSearchWarningEvent,
  type ApiSseFrame,
} from './analysis-sse.mapper';
import type { AnalysisSseEventName } from './analysis-sse.contract';
import type { EvidencePackService } from './evidence-pack.service';
import type { SseCallback } from './types';

/**
 * Factory the adapter calls to obtain the event stream. Default uses
 * agent's `streamComprehensive`; tests pass a fake that yields a scripted
 * event sequence so DB writes / SSE translation can be asserted without
 * running real LLM calls.
 */
export type StreamComprehensiveFactory = (
  provider: AgentProvider,
  input: DimensionInput,
  options: ComprehensiveOptions,
) => AsyncGenerator<SseEvent, unknown, undefined>;

const defaultFactory: StreamComprehensiveFactory = (
  provider,
  input,
  options,
) => streamComprehensive(provider, input, options);

/**
 * Single-dimension counterpart of StreamComprehensiveFactory. Default uses
 * agent's `streamSingle`; tests inject a scripted sequence.
 */
export type SingleStreamFactory = (
  provider: AgentProvider,
  input: DimensionInput,
) => AsyncGenerator<SseEvent, unknown, undefined>;

/**
 * Drives the package analysis workflow and bridges it to apps/api concerns:
 * evidence pack injection, API SSE frames, and database persistence. Both
 * comprehensive and single-dimension analyses enter through this adapter.
 */
export interface AdapterContext {
  analysisId: string;
  /**
   * 'comprehensive' (default) drives streamComprehensive over all dimensions;
   * 'single' drives streamSingle over the one dimension named by
   * `analysis.analysisType`.
   */
  mode?: 'comprehensive' | 'single';
  /** Loaded Analysis row including `.sections` (orderBy: order asc) + `.stock`. */
  analysis: AnalysisLike;
  provider: AgentProvider;
  /** apps/api SSE callback — translation target. */
  send: SseCallback;
  prisma: PrismaService;
  toolCache: ToolCacheService;
  /**
   * Explicit data-preparation stage. Builds the evidence pack (connector →
   * compute → snapshotToEvidencePack + CN tool signals) before workflow
   * execution. Optional so tests with scripted stream factories can omit it.
   */
  evidencePackService?: EvidencePackService;
  /** Resolved model id for telemetry tagging. */
  modelId: string;
  /** Provider name for telemetry tagging — 'claude' / 'openai'. */
  providerName: string;
  /** Per-wave concurrency cap forwarded into streamComprehensive. */
  waveSemaphore?: number;
  /**
   * Internal workflow recovery switch. When true and EvidencePack v2
   * hard-fails, agent retries with the v1 LLM web_search builder instead
   * of throwing.
   */
  allowWebSearchFallback?: boolean;
  /** Provider wired with the user's configured fallback web-search adapter. */
  fallbackProvider?: AgentProvider;
  /**
   * Test-only: substitute `streamComprehensive`. Production callers MUST
   * pass undefined; the adapter then uses the real agent workflow.
   */
  _streamFactory?: StreamComprehensiveFactory;
  /** Test-only: substitute `streamSingle` for mode==='single'. */
  _singleStreamFactory?: SingleStreamFactory;
}

/** Minimal shape of the Analysis row + relations the adapter touches. */
interface AnalysisLike {
  id: string;
  symbol: string;
  market: string;
  analysisType: string;
  userId: string;
  aiProvider?: string | null;
  aiModel?: string | null;
  sections: ReadonlyArray<AnalysisSectionLike>;
  stock: { symbol: string; market: string; name?: string | null };
}

interface AnalysisSectionLike {
  id: string;
  type: string;
  order: number;
  status: string;
}

export interface AdapterResult {
  terminalStatus: AnalysisTerminalStatus;
  factConflictCount: number;
  failedSectionTypes: string[];
}

const logger = new Logger('StreamComprehensiveAdapter');

export async function runStreamComprehensiveAdapter(
  ctx: AdapterContext,
): Promise<AdapterResult> {
  const tag = `[${ctx.analysisId}]`;
  const persistence = new AnalysisPersistenceMapper(ctx.prisma);

  // ===== Map sectionType → DB row id (O(1) lookup at event time) =====
  const sectionByType = new Map<string, AnalysisSectionLike>();
  for (const s of ctx.analysis.sections) {
    sectionByType.set(s.type, s);
  }

  // ===== Per-section accumulators (built on section_start) =====
  const sectionAccs = new Map<string, AnalysisSectionAccumulator>();

  // ===== Run-level state =====
  const failedSectionTypes: string[] = [];
  // Authoritative tally of sections that genuinely reached status=COMPLETED
  // via a section_complete SSE event. RunAggregate.sectionsCompletedCount
  // reads from here so abort / mid-stream throw can't inflate it.
  const completedSectionTypes = new Set<string>();

  let factConflictCount = 0;
  // ComprehensiveSummary surfaced via summary_complete — used to update
  // Analysis.overallSignal / overallConfidence / summaryMarkdown / summaryJson
  // before the terminal `done` SSE is sent.
  let summaryMarkdown = '';
  let summaryJson: unknown = null;
  // Captured on evidence_pack_ready and written to Analysis.degradedSource.
  let degradedSourceMark: 'WEB_SEARCH_FALLBACK' | null = null;
  let summaryDataAsOf: string | null = null;

  // ===== Assemble workflow options =====
  // marketProfile (CN only) feeds the cross-dim validator + domain-tier source
  // routing. Comprehensive passes the full profile (enables the validator);
  // single only uses its domainTiers → allowedDomains for web_search routing
  // (single has no cross-dim validator). The evidence pack is pre-built by
  // EvidencePackService below for BOTH modes.
  const marketProfile =
    ctx.analysis.stock.market === 'CN' ? getMarket('CN') ?? undefined : undefined;
  const marketDomainTiers = marketProfile?.domainTiers;
  const marketAllowedDomains = marketDomainTiers
    ? Object.keys(marketDomainTiers).filter((h) => marketDomainTiers[h] !== 'E')
    : undefined;

  const dimInput: DimensionInput = {
    symbol: ctx.analysis.stock.symbol,
    market: ctx.analysis.stock.market,
    locale: 'zh-CN',
    ...(ctx.analysis.stock.name ? { name: ctx.analysis.stock.name } : {}),
  };

  // Mark queued sections as IN_PROGRESS up front so concurrent reads see a
  // coherent run state rather than racing per-section updates.
  const queuedTypes = ctx.analysis.sections
    .filter((s) => s.status !== 'COMPLETED')
    .map((s) => s.id);
  await persistence.markQueuedSectionsInProgress(queuedTypes);

  // ===== Drive the agent workflow =====
  const todayDate = new Date().toISOString().slice(0, 10);

  // Path A: pre-build the evidence pack (connector → compute + CN tool signals)
  // for BOTH single and comprehensive — single-dim analyses now get the same
  // structured facts + computed ratios, not LLM-only. When it's absent or
  // critically degraded (neither quote nor financials) the comprehensive
  // workflow web_search-recovers; partial gaps are filled per-field by each
  // dim. (Tests omit evidencePackService + inject a stream factory.)
  const evidencePackResult = ctx.evidencePackService
    ? await ctx.evidencePackService.buildForAnalysis(ctx.analysis)
    : null;
  const prebuiltPack = evidencePackResult?.pack;
  if (evidencePackResult?.fallbackUsed) {
    degradedSourceMark = 'WEB_SEARCH_FALLBACK';
  }

  let gen: AsyncGenerator<SseEvent, unknown, undefined>;
  if (ctx.mode === 'single') {
    if (ctx._singleStreamFactory) {
      gen = ctx._singleStreamFactory(ctx.provider, dimInput);
    } else {
      const dimension = getDimension(
        ctx.analysis.analysisType as Parameters<typeof getDimension>[0],
      );
      if (!dimension) {
        throw new Error(
          `Unknown dimension for single-mode analysis: ${ctx.analysis.analysisType}`,
        );
      }
      gen = streamSingle(ctx.provider, dimension, dimInput, {
        runId: `analysis-${ctx.analysisId}`,
        todayDate,
        ...(prebuiltPack ? { evidencePack: prebuiltPack } : {}),
        ...(marketAllowedDomains && marketAllowedDomains.length > 0
          ? { allowedDomains: marketAllowedDomains }
          : {}),
        ...(marketDomainTiers ? { domainTiers: marketDomainTiers } : {}),
      });
    }
  } else {
    const factory = ctx._streamFactory ?? defaultFactory;
    gen = factory(ctx.provider, dimInput, {
      runId: `analysis-${ctx.analysisId}`,
      todayDate,
      waveMode: 'auto',
      ...(ctx.waveSemaphore ? { waveSemaphore: ctx.waveSemaphore } : {}),
      ...(marketProfile ? { marketProfile } : {}),
      ...(prebuiltPack ? { evidencePack: prebuiltPack } : {}),
      ...(ctx.allowWebSearchFallback
        ? { allowWebSearchFallback: true }
        : {}),
      ...(ctx.fallbackProvider
        ? { fallbackProvider: ctx.fallbackProvider }
        : {}),
    });
  }

  let terminalStatus: AdapterResult['terminalStatus'] = 'FAILED';

  try {
    while (true) {
      const next = await gen.next();
      if (next.done) {
        // Generator returns ComprehensiveResult; we've already consumed the
        // terminal `done` event above. Nothing more to do here.
        break;
      }
      const event = next.value;

      switch (event.type) {
        case 'evidence_pack_ready':
          sendFrame(ctx.send, mapEvidencePackReadyEvent(event));
          // Capture the degraded marker for the terminal Analysis row.
          {
            const da = (
              event.pack as {
                dataAvailability?: { degradedSource?: string };
              }
            ).dataAvailability;
            if (da?.degradedSource === 'WEB_SEARCH_FALLBACK') {
              degradedSourceMark = 'WEB_SEARCH_FALLBACK';
            }
          }
          break;

        case 'section_skipped':
          // Forward controlled skips and keep the section row consistent for
          // list/history views.
          {
            sendFrame(ctx.send, mapSectionSkippedEvent(event));
            const row = sectionByType.get(event.sectionType);
            if (row) await persistence.persistSectionSkipped(row.id);
          }
          break;

        case 'section_start': {
          const row = sectionByType.get(event.sectionType);
          if (!row) {
            logger.warn(
              `${tag} section_start for unknown sectionType=${event.sectionType}; skipping`,
            );
            break;
          }
          sectionAccs.set(event.sectionType, {
            sectionId: row.id,
            markdown: '',
            citations: [],
            structuredJson: null,
          });
          sendFrame(ctx.send, mapSectionStartEvent(event, row));
          break;
        }

        case 'report_chunk': {
          const acc = sectionAccs.get(event.sectionType);
          if (acc) acc.markdown += event.deltaText;
          sendFrame(ctx.send, mapReportChunkEvent(event));
          break;
        }

        case 'citation': {
          const acc = sectionAccs.get(event.sectionType);
          const cit = {
            title: event.citation.title,
            url: event.citation.url,
            sourceType: event.citation.sourceType,
            retrievedAt: event.citation.retrievedAt,
          };
          if (acc) acc.citations.push(cit);
          sendFrame(ctx.send, mapCitationEvent(event));
          break;
        }

        case 'report_complete': {
          const acc = sectionAccs.get(event.sectionType);
          if (acc) acc.markdown = event.fullMarkdown || acc.markdown;
          sendFrame(ctx.send, mapReportCompleteEvent(event.sectionType));
          break;
        }

        case 'structured_data': {
          const acc = sectionAccs.get(event.sectionType);
          if (acc) acc.structuredJson = event.json;
          sendFrame(ctx.send, mapStructuredDataEvent(event));
          break;
        }

        case 'web_search_warning': {
          // Forward web_search warnings to the client so a degraded run is
          // visible. (Telemetry accumulation removed — no SectionTrace sink.)
          sendFrame(ctx.send, mapWebSearchWarningEvent(event));
          break;
        }

        case 'section_complete': {
          const acc = sectionAccs.get(event.sectionType);
          if (!acc) {
            logger.warn(
              `${tag} section_complete for unknown sectionType=${event.sectionType}; skipping persistence`,
            );
            break;
          }
          const completed = event.status === 'COMPLETED';
          await persistence.persistSectionComplete(event, acc);
          if (completed) {
            completedSectionTypes.add(event.sectionType);
          } else {
            failedSectionTypes.push(event.sectionType);
          }
          sendFrame(ctx.send, mapSectionCompleteEvent(event));
          break;
        }

        case 'judge_start': {
          sendFrame(ctx.send, mapJudgeStartEvent(event));
          break;
        }

        case 'judge_complete': {
          sendFrame(ctx.send, mapJudgeCompleteEvent(event));

          const acc = sectionAccs.get(event.sectionType);
          if (acc) {
            await persistence.persistJudgeResult(ctx.analysisId, event, acc);
          }
          break;
        }

        case 'summary_chunk':
          summaryMarkdown += event.deltaText;
          sendFrame(ctx.send, mapSummaryChunkEvent(event));
          break;

        case 'summary_complete':
          summaryMarkdown = event.fullMarkdown || summaryMarkdown;
          summaryJson = event.json;
          summaryDataAsOf = (event.json as { dataAsOf?: string }).dataAsOf
            ?? null;
          // Preserve the synthetic COMPREHENSIVE report_complete frame that
          // the frontend uses to finalize summary rendering.
          sendFrame(ctx.send, mapReportCompleteEvent('COMPREHENSIVE'));
          sendFrame(ctx.send, mapSummaryCompleteEvent(event));
          break;

        case 'cost_update':
          // The API SSE contract does not expose cost_update frames.
          break;

        case 'error':
          // Forward as a non-terminal warning surface; terminal status is
          // decided by the `done` event below.
          logger.error(
            `${tag} dim ${event.sectionType ?? '(run-level)'} error: ${event.message}`,
          );
          sendFrame(ctx.send, mapErrorEvent(event));
          // Section-scoped errors may arrive without a later section_complete.
          // Persist the real message now so the orphan sweep does not replace
          // it with a generic run-level failure.
          if (event.sectionType) {
            const acc = sectionAccs.get(event.sectionType);
            if (acc) {
              try {
                await persistence.persistSectionErrorById(
                  acc.sectionId,
                  event.message,
                );
              } catch (e) {
                logger.warn(
                  `${tag} could not persist FAILED state for ${event.sectionType}: ${e instanceof Error ? e.message : String(e)}`,
                );
              }
            } else {
              // Section never got section_start (dim threw before yielding
              // it). updateMany by (analysisId, type) is the safe path.
              try {
                await persistence.persistSectionErrorByType(
                  ctx.analysisId,
                  event.sectionType,
                  event.message,
                );
              } catch (e) {
                logger.warn(
                  `${tag} could not persist FAILED state for ${event.sectionType}: ${e instanceof Error ? e.message : String(e)}`,
                );
              }
            }
            if (!failedSectionTypes.includes(event.sectionType)) {
              failedSectionTypes.push(event.sectionType);
            }
          }
          break;

        case 'done': {
          terminalStatus = event.status as AdapterResult['terminalStatus'];

          await persistence.persistRunDone({
            analysisId: ctx.analysisId,
            mode: ctx.mode,
            modelId: ctx.modelId,
            terminalStatus,
            summaryMarkdown,
            summaryJson,
            summaryDataAsOf,
            todayDate,
            degradedSourceMark,
            doneEvent: event,
          });
          sendFrame(ctx.send, mapDoneEvent(ctx.analysisId, terminalStatus));
          break;
        }
      }
    }
  } catch (err) {
    terminalStatus = 'FAILED';
    const message =
      err instanceof Error ? err.message : String(err ?? 'Unknown error');
    logger.error(
      `${tag} streamComprehensive threw (${terminalStatus}): ${message}`,
    );
    await persistence.persistRunFailed(ctx.analysisId);
    sendFrame(ctx.send, mapThrownError(message));
    sendFrame(ctx.send, mapDoneEvent(ctx.analysisId, terminalStatus));
  }

  // Every code path ends here: no section should remain PENDING/IN_PROGRESS
  // once the run has reached a terminal status.
  const orphanTypes = ctx.analysis.sections
    .map((s) => s.type)
    .filter(
      (t) =>
        !completedSectionTypes.has(t) && !failedSectionTypes.includes(t),
    );
  if (orphanTypes.length > 0) {
    try {
      await persistence.sweepOrphanSections({
        analysisId: ctx.analysisId,
        orphanTypes,
        terminalStatus,
      });
    } catch (e) {
      logger.warn(
        `${tag} orphan-section sweep failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    for (const t of orphanTypes) failedSectionTypes.push(t);
  }

  return {
    terminalStatus,
    factConflictCount,
    failedSectionTypes,
  };
}

function sendFrame<T extends AnalysisSseEventName>(
  send: SseCallback,
  frame: ApiSseFrame<T>,
) {
  send(frame.event, frame.data);
}
