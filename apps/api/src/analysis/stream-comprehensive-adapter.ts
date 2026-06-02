import { Logger } from '@nestjs/common';
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
import type { ToolCacheService } from '../lifecycle/tool-cache.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { SnapshotV2Service } from './snapshot-v2.service';
import type { SseCallback } from './analysis.service';

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
 * RFC-07 P1: adapter that drives `streamComprehensive` from the agent
 * package and projects its `SseEvent` stream onto apps/api's existing SSE
 * client protocol + DB persistence shape. This is now the sole orchestration
 * path for all analyses — comprehensive (all dims + summary) and single (one
 * dim via streamSingle), across every market. The legacy hand-rolled path and
 * its `ANALYSIS_USE_STREAM_COMPREHENSIVE` feature flag have been removed.
 *
 * Single source of truth for orchestration (Stage 0 EvidencePack v2, DAG
 * Wave concurrency, cross-dim validator, summary phase) is the agent
 * package; this file is glue:
 *   - translate agent SSE events → apps/api SSE event shapes (frontend
 *     contract unchanged)
 *   - write AnalysisSection + Analysis rows at the right points
 *   - propagate validator DOWNGRADE mutations back to the section JSON
 */

const VALID_SIGNALS = new Set(['BULLISH', 'NEUTRAL', 'BEARISH']);
const VALID_CONFIDENCES = new Set(['HIGH', 'MEDIUM', 'LOW']);

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
   * Path A: builds the evidence pack (connector → compute → snapshotToEvidencePack
   * + CN tool signals) for comprehensive runs, all markets. Optional so tests
   * (which inject a scripted `_streamFactory`) can omit it.
   */
  snapshotV2?: SnapshotV2Service;
  /** Resolved model id for telemetry tagging. */
  modelId: string;
  /** Provider name for telemetry tagging — 'claude' / 'openai'. */
  providerName: string;
  /** Per-wave concurrency cap forwarded into streamComprehensive. */
  waveSemaphore?: number;
  /**
   * RFC rfc-evidence-pack-web-search-fallback: user-level opt-in. When
   * true and EvidencePack v2 hard-fails, agent retries with v1 LLM
   * web_search builder instead of throwing. Sourced from
   * User.allowWebSearchFallback by AnalysisService.
   */
  allowWebSearchFallback?: boolean;
  /**
   * RFC rfc-web-search-backend-config: provider wired with the user's
   * "fallback" web_search adapter. When set, the v1 builder uses this
   * provider instead of `ctx.provider`.
   */
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
  terminalStatus: 'COMPLETED' | 'PARTIAL_FAILED' | 'FAILED' | 'CANCELLED';
  factConflictCount: number;
  failedSectionTypes: string[];
}

/** Per-section state accumulated while events stream in. */
interface SectionAccumulator {
  sectionId: string;
  markdown: string;
  citations: Array<{
    title: string;
    url: string;
    sourceType: string;
    retrievedAt: string;
  }>;
  structuredJson: unknown;
}

const logger = new Logger('StreamComprehensiveAdapter');

export async function runStreamComprehensiveAdapter(
  ctx: AdapterContext,
): Promise<AdapterResult> {
  const tag = `[${ctx.analysisId}]`;

  // ===== Map sectionType → DB row id (O(1) lookup at event time) =====
  const sectionByType = new Map<string, AnalysisSectionLike>();
  for (const s of ctx.analysis.sections) {
    sectionByType.set(s.type, s);
  }

  // ===== Per-section accumulators (built on section_start) =====
  const sectionAccs = new Map<string, SectionAccumulator>();

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
  // RFC rfc-evidence-pack-web-search-fallback: captured on
  // `evidence_pack_ready`, written to Analysis.degradedSource at terminal.
  let degradedSourceMark: 'WEB_SEARCH_FALLBACK' | null = null;
  let summaryDataAsOf: string | null = null;

  // ===== Assemble workflow options =====
  // marketProfile (CN only) feeds the cross-dim validator + domain-tier source
  // routing. Comprehensive passes the full profile (enables the validator);
  // single only uses its domainTiers → allowedDomains for web_search routing
  // (single has no cross-dim validator). The evidence pack is pre-built via
  // Path A (ctx.snapshotV2) below for BOTH modes.
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

  // Mark every queued section as IN_PROGRESS up front so the DB matches the
  // legacy path's behavior (legacy flips each section to IN_PROGRESS at
  // `runSection` start). This lets concurrent reads (e.g. retry endpoint)
  // see "all sections are mid-run" rather than racing per-section flips.
  const queuedTypes = ctx.analysis.sections
    .filter((s) => s.status !== 'COMPLETED')
    .map((s) => s.id);
  if (queuedTypes.length > 0) {
    await ctx.prisma.analysisSection.updateMany({
      where: { id: { in: queuedTypes } },
      data: { status: 'IN_PROGRESS' as never },
    });
  }

  // ===== Drive the agent workflow =====
  const todayDate = new Date().toISOString().slice(0, 10);

  // Path A: pre-build the evidence pack (connector → compute + CN tool signals)
  // for BOTH single and comprehensive — single-dim analyses now get the same
  // structured facts + computed ratios, not LLM-only. When it's absent or
  // critically degraded (neither quote nor financials) the comprehensive
  // workflow web_search-recovers; partial gaps are filled per-field by each
  // dim. (Tests omit snapshotV2 + inject a stream factory.)
  let prebuiltPack: EvidencePackAny | undefined;
  if (ctx.snapshotV2) {
    try {
      prebuiltPack = await ctx.snapshotV2.fetchAsEvidencePack(
        ctx.analysis.stock.symbol,
        ctx.analysis.stock.market as 'US' | 'CN' | 'HK',
      );
    } catch (err) {
      logger.warn(
        `${tag} SnapshotV2 evidence pack build failed: ${
          err instanceof Error ? err.message : String(err)
        } — dims fall back to web_search`,
      );
    }
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
      // RFC-05: wave-mode is the whole point of this adapter — let RFC-04
      // cache and RFC-05 wave gates take effect in prod.
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
          ctx.send('evidence_pack_ready', { pack: event.pack });
          // RFC rfc-evidence-pack-web-search-fallback: capture degraded
          // marker from the pack (v1-shape only — v2 has no such field).
          // Used at terminal write to populate Analysis.degradedSource.
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
          // RFC rfc-evidence-pack-web-search-fallback §2.4: forward so UI
          // can render the SKIPPED card. Also flip the corresponding
          // Section row's status so list views stay consistent.
          {
            const evt = event as {
              sectionType: string;
              reason: string;
              missingFields: string[];
            };
            ctx.send('section_skipped', {
              sectionType: evt.sectionType,
              reason: evt.reason,
              missingFields: evt.missingFields,
            });
            const row = sectionByType.get(evt.sectionType);
            if (row) {
              await ctx.prisma.analysisSection.update({
                where: { id: row.id },
                data: { status: 'FAILED' as never },
              });
            }
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
          ctx.send('section_start', {
            sectionType: event.sectionType,
            sectionId: row.id,
            order: event.order ?? row.order,
          });
          break;
        }

        case 'report_chunk': {
          const acc = sectionAccs.get(event.sectionType);
          if (acc) acc.markdown += event.deltaText;
          ctx.send('report_chunk', {
            text: event.deltaText,
            sectionType: event.sectionType,
          });
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
          ctx.send('citation', {
            title: event.citation.title,
            url: event.citation.url,
            claim: '',
            sectionType: event.sectionType,
            // RFC rfc-web-search-backend-config §2.3
            ...(event.citation.searchAdapter
              ? { searchAdapter: event.citation.searchAdapter }
              : {}),
          });
          break;
        }

        case 'report_complete': {
          const acc = sectionAccs.get(event.sectionType);
          if (acc) acc.markdown = event.fullMarkdown || acc.markdown;
          ctx.send('report_complete', { sectionType: event.sectionType });
          break;
        }

        case 'structured_data': {
          const acc = sectionAccs.get(event.sectionType);
          if (acc) acc.structuredJson = event.json;
          ctx.send('structured_data', {
            json: event.json,
            sectionType: event.sectionType,
          });
          break;
        }

        case 'web_search_warning': {
          // Forward web_search warnings to the client so a degraded run is
          // visible. (Telemetry accumulation removed — no SectionTrace sink.)
          ctx.send('web_search_warning', {
            sectionType: event.sectionType,
            code: event.code,
            occurredAt: event.occurredAt,
            round: event.round,
          });
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
          await ctx.prisma.analysisSection.update({
            where: { id: acc.sectionId },
            data: {
              status: event.status as never,
              reportMarkdown: acc.markdown,
              structuredJson: (acc.structuredJson as never) ?? undefined,
              citations:
                acc.citations.length > 0
                  ? (acc.citations as never)
                  : undefined,
            },
          });
          if (completed) {
            completedSectionTypes.add(event.sectionType);
          } else {
            failedSectionTypes.push(event.sectionType);
          }
          ctx.send('section_complete', {
            sectionType: event.sectionType,
            status: event.status,
          });
          break;
        }

        // plan-v2 Wave 3.3: cross_dim_warning case removed. Validator still
        // runs inside the agent workflow; conflict messages fold into the
        // run-level warnings list (visible via ComprehensiveResult), and
        // downgrade persistence is no longer needed for the SSE consumer.

        case 'judge_start': {
          // RFC-10 P4: forward verbatim; frontend may show a "审计中" badge
          // or ignore the event entirely (no contract break — new event).
          ctx.send('judge_start', { sectionType: event.sectionType });
          break;
        }

        case 'judge_complete': {
          ctx.send('judge_complete', {
            sectionType: event.sectionType,
            result: event.result,
            traceTokensIn: event.traceTokensIn,
            traceTokensOut: event.traceTokensOut,
            traceCostUsd: event.traceCostUsd,
            traceDurationMs: event.traceDurationMs,
          });

          // Merge JudgeResult into the section's persisted structuredJson
          // as a `judgeResult` sub-field; apply confidence downgrade in
          // place if the audit said so. Schema-free (Prisma stores JSON).
          const acc = sectionAccs.get(event.sectionType);
          if (acc && acc.structuredJson && typeof acc.structuredJson === 'object') {
            const json = acc.structuredJson as Record<string, unknown>;
            json.judgeResult = event.result;
            if (
              event.result.confidenceAdjustment === 'DOWNGRADE_TO_MEDIUM' ||
              event.result.confidenceAdjustment === 'DOWNGRADE_TO_LOW'
            ) {
              const target =
                event.result.confidenceAdjustment === 'DOWNGRADE_TO_LOW'
                  ? 'LOW'
                  : 'MEDIUM';
              const conclusion = json.conclusion as
                | { confidence?: string }
                | undefined;
              if (conclusion) conclusion.confidence = target;
            }
            await ctx.prisma.analysisSection.updateMany({
              where: {
                analysisId: ctx.analysisId,
                type: event.sectionType as never,
              },
              data: { structuredJson: acc.structuredJson as never },
            });
          }
          break;
        }

        case 'summary_chunk':
          summaryMarkdown += event.deltaText;
          ctx.send('summary_chunk', { text: event.deltaText });
          break;

        case 'summary_complete':
          summaryMarkdown = event.fullMarkdown || summaryMarkdown;
          summaryJson = event.json;
          summaryDataAsOf = (event.json as { dataAsOf?: string }).dataAsOf
            ?? null;
          // apps/api legacy path emits a `report_complete` for the
          // synthetic COMPREHENSIVE "section" right before summary_complete;
          // preserve that for frontend parity.
          ctx.send('report_complete', { sectionType: 'COMPREHENSIVE' });
          ctx.send('summary_complete', { summaryJson: event.json });
          break;

        case 'cost_update':
          // Legacy apps/api SSE doesn't surface cost_update to clients;
          // run-level totals land in RunAggregate via section_complete usage.
          break;

        case 'error':
          // Forward as a non-terminal warning surface; terminal status is
          // decided by the `done` event below.
          // 2026-05-19: log to stdout too — DB.errorMessage was the only
          // sink before, so triage required querying DB. Devs running
          // `pnpm dev` should see actual upstream errors (typically
          // "400 Param Incorrect" from OpenAI-compat vendors).
          logger.error(
            `${tag} dim ${event.sectionType ?? '(run-level)'} error: ${event.message}`,
          );
          ctx.send('error', {
            message: event.message,
            ...(event.sectionType
              ? { failedSections: [event.sectionType] }
              : {}),
          });
          // Fix (2026-05-16): when the agent surfaces a section-scoped
          // error (typical: dim throws inside streamDimension — e.g.
          // provider 404 / network hang / JSON parse fail), it does NOT
          // yield a section_complete event afterwards. Without writing
          // FAILED + real errorMessage here, the orphan sweep at the end
          // overwrites with a generic "Run failed before this section
          // completed" — burying the actual error. Capture it now so the
          // UI / retry endpoint / log triage all see the real cause.
          if (event.sectionType) {
            const acc = sectionAccs.get(event.sectionType);
            if (acc) {
              try {
                await ctx.prisma.analysisSection.update({
                  where: { id: acc.sectionId },
                  data: {
                    status: 'FAILED' as never,
                    errorMessage: event.message,
                  },
                });
              } catch (e) {
                logger.warn(
                  `${tag} could not persist FAILED state for ${event.sectionType}: ${e instanceof Error ? e.message : String(e)}`,
                );
              }
            } else {
              // Section never got section_start (dim threw before yielding
              // it). updateMany by (analysisId, type) is the safe path.
              try {
                await ctx.prisma.analysisSection.updateMany({
                  where: {
                    analysisId: ctx.analysisId,
                    type: event.sectionType as never,
                    status: { in: ['PENDING', 'IN_PROGRESS'] as never },
                  },
                  data: {
                    status: 'FAILED' as never,
                    errorMessage: event.message,
                  },
                });
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

          // Overall signal/confidence/dataAsOf source:
          //  - comprehensive → the summary JSON
          //  - single        → the dimension's own conclusion (done.result),
          //    mirroring the legacy single finalize.
          let overallSignal: string | undefined;
          let overallConfidence: string | undefined;
          let dataAsOf: string | undefined;
          if (ctx.mode === 'single') {
            const result = (
              event as {
                result?: {
                  signal?: string;
                  confidence?: string;
                  structuredJson?: { dataAsOf?: string } | null;
                };
              }
            ).result;
            overallSignal = result?.signal;
            overallConfidence = result?.confidence;
            dataAsOf = result?.structuredJson?.dataAsOf ?? todayDate;
          } else {
            const summaryRow =
              summaryJson !== null
                ? (summaryJson as {
                    overallSignal?: string;
                    overallConfidence?: string;
                  })
                : null;
            overallSignal = summaryRow?.overallSignal;
            overallConfidence = summaryRow?.overallConfidence;
            dataAsOf = summaryDataAsOf ?? undefined;
          }

          await ctx.prisma.analysis.update({
            where: { id: ctx.analysisId },
            data: {
              status: terminalStatus as never,
              aiModel: ctx.modelId,
              generatedAt: new Date(),
              ...(ctx.mode !== 'single' && summaryMarkdown
                ? { summaryMarkdown }
                : {}),
              ...(ctx.mode !== 'single' && summaryJson !== null
                ? { summaryJson: summaryJson as never }
                : {}),
              ...(overallSignal && VALID_SIGNALS.has(overallSignal)
                ? { overallSignal: overallSignal as never }
                : {}),
              ...(overallConfidence &&
              VALID_CONFIDENCES.has(overallConfidence)
                ? { overallConfidence: overallConfidence as never }
                : {}),
              ...(dataAsOf ? { dataAsOf } : {}),
              ...(degradedSourceMark
                ? { degradedSource: degradedSourceMark }
                : {}),
            },
          });
          ctx.send('done', {
            analysisId: ctx.analysisId,
            status: terminalStatus,
          });
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
    await ctx.prisma.analysis.update({
      where: { id: ctx.analysisId },
      data: { status: terminalStatus as never },
    });
    ctx.send('error', { message });
    ctx.send('done', {
      analysisId: ctx.analysisId,
      status: terminalStatus,
    });
  }

  // Fix (2026-05-16): every code path ends here — make sure no section
  // is left at status=PENDING/IN_PROGRESS in the DB. If a wave was abort-
  // cancelled mid-stream or a dim threw before its section_complete event
  // landed, those rows would otherwise stay IN_PROGRESS forever, the
  // RunAggregate count would lie, and the UI would show a perpetual
  // spinner. We sweep here, mark orphans with the appropriate terminal
  // status, and fold them into failedSectionTypes so the aggregate read
  // below is honest.
  const orphanTypes = ctx.analysis.sections
    .map((s) => s.type)
    .filter(
      (t) =>
        !completedSectionTypes.has(t) && !failedSectionTypes.includes(t),
    );
  if (orphanTypes.length > 0) {
    const orphanStatus =
      terminalStatus === 'CANCELLED' ? 'CANCELLED' : 'FAILED';
    const orphanMsg =
      terminalStatus === 'CANCELLED'
        ? 'Run cancelled before this section completed'
        : 'Run failed before this section completed';
    try {
      await ctx.prisma.analysisSection.updateMany({
        where: {
          analysisId: ctx.analysisId,
          type: { in: orphanTypes as never },
          status: { in: ['PENDING', 'IN_PROGRESS'] as never },
        },
        data: {
          status: orphanStatus as never,
          errorMessage: orphanMsg,
        },
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
