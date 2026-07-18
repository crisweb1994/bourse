import { Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { AnalysisTerminalStatus } from '@bourse/shared-types';
import {
  type AgentProvider,
  type ComprehensiveOptions,
  type DimensionInput,
  type EvidencePackAny,
  getDimension,
  getMarket,
  type SseEvent,
  streamComprehensive,
  streamSingle,
} from '@bourse/analysis';
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
  mapReportChunkEvent,
  mapSectionCompleteEvent,
  mapSectionSkippedEvent,
  mapSectionStartEvent,
  mapStructuredDataEvent,
  mapSummaryChunkEvent,
  mapSummaryCompleteEvent,
  mapThrownError,
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
  /**
   * Explicit data-preparation stage. Builds the evidence pack (connector →
   * compute → snapshotToEvidencePack + CN tool signals) before workflow
   * execution. Optional so tests with scripted stream factories can omit it.
   */
  evidencePackService?: EvidencePackService;
  /** Resolved model written back to the Analysis row. */
  aiModel: string;
  /** Per-wave concurrency cap forwarded into streamComprehensive. */
  waveSemaphore?: number;
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
  analysisType: string;
  question?: string | null;
  promptVersion?: string | null;
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

const logger = new Logger('AnalysisWorkflowAdapter');

export async function runAnalysisWorkflowAdapter(
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
  let capturedEvidencePack: EvidencePackAny | undefined;

  // ===== Event handlers (close over mutable run state above) =====

  function onEvidencePackReady(event: Extract<SseEvent, { type: 'evidence_pack_ready' }>) {
    capturedEvidencePack = event.pack as EvidencePackAny;
    sendFrame(ctx.send, mapEvidencePackReadyEvent(event));
    // Capture the degraded marker for the terminal Analysis row.
    const da = (
      event.pack as { dataAvailability?: { degradedSource?: string } }
    ).dataAvailability;
    if (da?.degradedSource === 'WEB_SEARCH_FALLBACK') {
      degradedSourceMark = 'WEB_SEARCH_FALLBACK'; // mutates outer state
    }
  }

  async function onSectionSkipped(event: Extract<SseEvent, { type: 'section_skipped' }>) {
    sendFrame(ctx.send, mapSectionSkippedEvent(event));
    const row = sectionByType.get(event.sectionType);
    if (row) await persistence.persistSectionSkipped(row.id);
  }

  function onSectionStart(event: Extract<SseEvent, { type: 'section_start' }>) {
    const row = sectionByType.get(event.sectionType);
    if (!row) {
      logger.warn(
        `${tag} section_start for unknown sectionType=${event.sectionType}; skipping`,
      );
      return;
    }
    sectionAccs.set(event.sectionType, { // mutates outer state
      sectionId: row.id,
      markdown: '',
      citations: [],
      structuredJson: null,
    });
    sendFrame(ctx.send, mapSectionStartEvent(event, row));
  }

  function onReportChunk(event: Extract<SseEvent, { type: 'report_chunk' }>) {
    const acc = sectionAccs.get(event.sectionType);
    if (acc) acc.markdown += event.deltaText; // mutates acc
    sendFrame(ctx.send, mapReportChunkEvent(event));
  }

  function onCitation(event: Extract<SseEvent, { type: 'citation' }>) {
    const acc = sectionAccs.get(event.sectionType);
    const cit = {
      title: event.citation.title,
      url: event.citation.url,
      sourceType: event.citation.sourceType,
      retrievedAt: event.citation.retrievedAt,
    };
    if (acc) acc.citations.push(cit); // mutates acc
    sendFrame(ctx.send, mapCitationEvent(event));
  }

  function onReportComplete(event: Extract<SseEvent, { type: 'report_complete' }>) {
    // No SSE — overwrites chunk accumulation with the authoritative full markdown.
    const acc = sectionAccs.get(event.sectionType);
    if (acc) acc.markdown = event.fullMarkdown || acc.markdown; // mutates acc
  }

  function onStructuredData(event: Extract<SseEvent, { type: 'structured_data' }>) {
    const acc = sectionAccs.get(event.sectionType);
    if (acc) acc.structuredJson = event.json; // mutates acc
    sendFrame(ctx.send, mapStructuredDataEvent(event));
  }

  async function onSectionComplete(event: Extract<SseEvent, { type: 'section_complete' }>) {
    const acc = sectionAccs.get(event.sectionType);
    if (!acc) {
      logger.warn(
        `${tag} section_complete for unknown sectionType=${event.sectionType}; skipping persistence`,
      );
      return;
    }
    const completed = event.status === 'COMPLETED';
    await persistence.persistSectionComplete(event, acc);
    if (completed) {
      completedSectionTypes.add(event.sectionType); // mutates outer state
    } else {
      failedSectionTypes.push(event.sectionType); // mutates outer state
    }
    sendFrame(ctx.send, mapSectionCompleteEvent(event));
  }

  async function onJudgeComplete(event: Extract<SseEvent, { type: 'judge_complete' }>) {
    const acc = sectionAccs.get(event.sectionType);
    if (acc) {
      await persistence.persistJudgeResult(ctx.analysisId, event, acc);
    }
  }

  function onSummaryChunk(event: Extract<SseEvent, { type: 'summary_chunk' }>) {
    summaryMarkdown += event.deltaText; // mutates outer state
    sendFrame(ctx.send, mapSummaryChunkEvent(event));
  }

  function onSummaryComplete(event: Extract<SseEvent, { type: 'summary_complete' }>) {
    summaryMarkdown = event.fullMarkdown || summaryMarkdown; // mutates outer state
    summaryJson = event.json;
    summaryDataAsOf = (event.json as { dataAsOf?: string }).dataAsOf ?? null;
    sendFrame(ctx.send, mapSummaryCompleteEvent(event));
  }

  async function onError(event: Extract<SseEvent, { type: 'error' }>) {
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
          await persistence.persistSectionErrorById(acc.sectionId, event.message);
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
        failedSectionTypes.push(event.sectionType); // mutates outer state
      }
    }
  }

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
    ...(ctx.analysis.question ? { question: ctx.analysis.question } : {}),
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
  capturedEvidencePack = prebuiltPack;
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
      recoverMissingEvidence: true,
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
        case 'evidence_pack_ready': onEvidencePackReady(event); break;
        case 'section_skipped':     await onSectionSkipped(event); break;
        case 'section_start':       onSectionStart(event); break;
        case 'report_chunk':        onReportChunk(event); break;
        case 'citation':            onCitation(event); break;
        case 'report_complete':     onReportComplete(event); break;  // no SSE, state only
        case 'structured_data':     onStructuredData(event); break;
        case 'web_search_warning':  break;  // not forwarded to API SSE
        case 'section_complete':    await onSectionComplete(event); break;
        case 'judge_start':         break;  // no action needed
        case 'judge_complete':      await onJudgeComplete(event); break;
        case 'summary_chunk':       onSummaryChunk(event); break;
        case 'summary_complete':    onSummaryComplete(event); break;
        case 'cost_update':         break;  // not exposed in API SSE contract
        case 'error':               await onError(event); break;

        case 'done': {
          terminalStatus = event.status as AdapterResult['terminalStatus'];
          await persistence.persistRunDone({
            analysisId: ctx.analysisId,
            mode: ctx.mode,
            aiModel: ctx.aiModel,
            terminalStatus,
            summaryMarkdown,
            summaryJson,
            summaryDataAsOf,
            todayDate,
            degradedSourceMark,
            doneEvent: event,
          });
          if (
            capturedEvidencePack &&
            (terminalStatus === 'COMPLETED' || terminalStatus === 'PARTIAL_FAILED')
          ) {
            try {
              await persistEvidenceSnapshot(
                ctx.prisma,
                ctx.analysisId,
                capturedEvidencePack,
                {
                  degraded: degradedSourceMark !== null,
                  sourceMode: degradedSourceMark
                    ? 'WEB_SEARCH_FALLBACK'
                    : 'EVIDENCE_PACK',
                  provider: ctx.provider.name,
                  model: ctx.aiModel,
                  promptVersion: ctx.analysis.promptVersion ?? null,
                  sectionSources: [...sectionAccs.entries()].map(
                    ([sectionType, acc]) => ({
                      sectionType,
                      citations: acc.citations,
                    }),
                  ),
                },
              );
            } catch (snapshotError) {
              logger.warn(
                `${tag} evidence snapshot persistence failed: ${snapshotError instanceof Error ? snapshotError.message : String(snapshotError)}`,
              );
            }
          }
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

async function persistEvidenceSnapshot(
  prisma: PrismaService,
  analysisId: string,
  pack: EvidencePackAny,
  options: {
    sourceMode: string;
    degraded: boolean;
    provider?: string | null;
    model?: string | null;
    promptVersion?: string | null;
    sectionSources?: unknown[];
  },
) {
  const snapshotStore = (prisma as any).analysisEvidenceSnapshot;
  if (!snapshotStore?.upsert) {
    logger.warn(
      `[${analysisId}] evidence snapshot delegate unavailable; run db:generate before production use`,
    );
    return;
  }

  const raw = pack as unknown as Record<string, any>;
  const availability = raw.dataAvailability ?? {};
  const missing = Array.isArray(availability.missing)
    ? availability.missing.map((item: any) =>
        typeof item === 'string' ? item : String(item?.field ?? 'unknown'),
      )
    : [];
  const citations = Array.isArray(raw.citations) ? raw.citations : [];
  const capturedAt =
    typeof raw.capturedAt === 'string'
      ? raw.capturedAt
      : new Date().toISOString();
  const contentHash = createHash('sha256')
    .update(canonicalJson(pack))
    .digest('hex');

  await snapshotStore.upsert({
    where: { analysisId },
    create: {
      analysisId,
      schemaVersion: String(raw.schemaVersion ?? 'unknown'),
      evidencePackVersion: String(raw.schemaVersion ?? 'unknown'),
      capturedAt: new Date(capturedAt),
      dataAsOf: raw.dataAsOf ?? capturedAt,
      sourceMode: options.sourceMode,
      degraded: options.degraded,
      missingFields: missing,
      payload: pack as any,
      sourceSnapshots: [
        ...citations,
        ...(options.sectionSources ?? []),
      ] as any,
      metadata: {
        provider: options.provider ?? null,
        model: options.model ?? null,
        promptVersion: options.promptVersion ?? null,
      } as any,
      contentHash,
    },
    update: {},
  });
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(',')}}`;
}
