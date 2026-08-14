import { Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type {
  AnalysisMode,
  AnalysisTerminalStatus,
  FocusWindow,
} from '@bourse/shared-types';
import {
  type AgentProvider,
  type ComprehensiveOptions,
  type DimensionInput,
  type EvidencePackV2,
  getMarket,
  SectionResult,
  type SseEvent,
  streamComprehensive,
} from '@bourse/analysis';
import type { PrismaService } from '../prisma/prisma.service';
import {
  AnalysisPersistenceMapper,
  type AnalysisSectionAccumulator,
} from './analysis-persistence.mapper';
import {
  mapCitationEvent,
  mapCostUpdateEvent,
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

export type StreamComprehensiveFactory = (
  provider: AgentProvider,
  input: DimensionInput,
  options: ComprehensiveOptions,
) => AsyncGenerator<SseEvent, unknown, undefined>;

const defaultFactory: StreamComprehensiveFactory = (provider, input, options) =>
  streamComprehensive(provider, input, options);

export interface AdapterContext {
  analysisId: string;
  mode: AnalysisMode;
  focusWindow: FocusWindow;
  analysis: AnalysisLike;
  provider: AgentProvider;
  send: SseCallback;
  prisma: PrismaService;
  evidencePackService?: EvidencePackService;
  aiModel: string;
  waveSemaphore?: number;
  signal?: AbortSignal;
  _streamFactory?: StreamComprehensiveFactory;
}

interface AnalysisLike {
  id: string;
  mode: AnalysisMode;
  focusWindow: FocusWindow;
  question?: string | null;
  sections: ReadonlyArray<AnalysisSectionLike>;
  stock: { symbol: string; market: string; name?: string | null };
}

interface AnalysisSectionLike {
  id: string;
  type: string;
  order: number;
  status: string;
  reportMarkdown?: string | null;
  structuredJson?: unknown;
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
  const sectionByType = new Map<string, AnalysisSectionLike>(
    ctx.analysis.sections.map((section) => [section.type, section]),
  );
  const sectionAccs = new Map<string, AnalysisSectionAccumulator>();
  const completedSectionTypes = new Set<string>();
  const failedSectionTypes: string[] = [];

  let summaryMarkdown = '';
  let summaryJson: unknown = null;
  let summaryDataAsOf: string | null = null;
  let capturedEvidencePack: EvidencePackV2 | undefined;
  let snapshotPersisted = false;
  let degradedSourceMark: 'WEB_SEARCH_FALLBACK' | null = null;
  let accumulatedInputTokens = 0;
  let accumulatedOutputTokens = 0;
  let terminalStatus: AdapterResult['terminalStatus'] = 'FAILED';

  const addFailed = (type: string) => {
    if (!failedSectionTypes.includes(type)) failedSectionTypes.push(type);
  };

  // A retry keeps completed sections in the same Analysis row. Feed their
  // validated results back into the workflow so only failed/skipped sections
  // make provider calls while the summary still sees the whole report.
  const existingResults = ctx.analysis.sections.flatMap((section) => {
    if (section.status !== 'COMPLETED') return [];
    const parsed = SectionResult.safeParse(section.structuredJson);
    if (!parsed.success) return [];
    completedSectionTypes.add(section.type);
    const citations = parsed.data.findings.flatMap((finding) =>
      finding.evidence.flatMap((evidence) => evidence.citations),
    );
    const uniqueCitations = Array.from(
      new Map(citations.map((citation) => [citation.url, citation])).values(),
    );
    return [{
      type: parsed.data.type,
      reportMarkdown: section.reportMarkdown ?? '',
      structuredJson: parsed.data,
      citations: uniqueCitations,
      confidence: parsed.data.confidence,
      status: 'COMPLETED' as const,
      warnings: [],
      usage: { tokensIn: 0, tokensOut: 0 },
    }];
  });

  const onEvidencePackReady = async (
    event: Extract<SseEvent, { type: 'evidence_pack_ready' }>,
  ) => {
    capturedEvidencePack = event.pack as EvidencePackV2;
    const availability = (
      capturedEvidencePack as { dataAvailability?: { degradedSource?: string } }
    ).dataAvailability;
    if (availability?.degradedSource === 'WEB_SEARCH_FALLBACK') {
      degradedSourceMark = 'WEB_SEARCH_FALLBACK';
    }
    if (!snapshotPersisted && capturedEvidencePack) {
      await persistEvidenceSnapshot(ctx.prisma, ctx.analysisId, capturedEvidencePack, {
        degraded: degradedSourceMark !== null,
        sourceMode: degradedSourceMark ? 'WEB_SEARCH_FALLBACK' : 'EVIDENCE_PACK',
      });
      snapshotPersisted = true;
    }
    sendFrame(ctx.send, mapEvidencePackReadyEvent(event));
  };

  const onSectionSkipped = async (
    event: Extract<SseEvent, { type: 'section_skipped' }>,
  ) => {
    const row = sectionByType.get(event.sectionType);
    if (row) {
      await persistence.persistSectionSkipped(row.id, event.reason);
    }
    addFailed(event.sectionType);
    sendFrame(ctx.send, mapSectionSkippedEvent(event));
  };

  const onSectionStart = (event: Extract<SseEvent, { type: 'section_start' }>) => {
    const row = sectionByType.get(event.sectionType);
    if (!row) {
      logger.warn(`${tag} unknown section ${event.sectionType}`);
      return;
    }
    sectionAccs.set(event.sectionType, {
      sectionId: row.id,
      markdown: '',
      citations: [],
      structuredJson: null,
    });
    sendFrame(ctx.send, mapSectionStartEvent(event, row));
  };

  const onReportChunk = (event: Extract<SseEvent, { type: 'report_chunk' }>) => {
    const acc = sectionAccs.get(event.sectionType);
    if (acc) acc.markdown += event.deltaText;
    sendFrame(ctx.send, mapReportChunkEvent(event));
  };

  const onCitation = (event: Extract<SseEvent, { type: 'citation' }>) => {
    const acc = sectionAccs.get(event.sectionType);
    if (acc) {
      acc.citations.push({
        title: event.citation.title,
        url: event.citation.url,
        sourceType: event.citation.sourceType,
        retrievedAt: event.citation.retrievedAt,
      });
    }
    sendFrame(ctx.send, mapCitationEvent(event));
  };

  const onReportComplete = (event: Extract<SseEvent, { type: 'report_complete' }>) => {
    const acc = sectionAccs.get(event.sectionType);
    if (acc) acc.markdown = event.fullMarkdown || acc.markdown;
  };

  const onStructuredData = (event: Extract<SseEvent, { type: 'structured_data' }>) => {
    const acc = sectionAccs.get(event.sectionType);
    if (acc) acc.structuredJson = event.json;
    sendFrame(ctx.send, mapStructuredDataEvent(event));
  };

  const onSectionComplete = async (
    event: Extract<SseEvent, { type: 'section_complete' }>,
  ) => {
    const acc = sectionAccs.get(event.sectionType);
    if (!acc) {
      addFailed(event.sectionType);
      return;
    }
    await persistence.persistSectionComplete(event, acc);
    if (event.status === 'COMPLETED') completedSectionTypes.add(event.sectionType);
    else addFailed(event.sectionType);
    if (event.usage) {
      accumulatedInputTokens += event.usage.tokensIn;
      accumulatedOutputTokens += event.usage.tokensOut;
    }
    sendFrame(ctx.send, mapSectionCompleteEvent(event));
  };

  const onSummaryChunk = (event: Extract<SseEvent, { type: 'summary_chunk' }>) => {
    summaryMarkdown += event.deltaText;
    sendFrame(ctx.send, mapSummaryChunkEvent(event));
  };

  const onSummaryComplete = (
    event: Extract<SseEvent, { type: 'summary_complete' }>,
  ) => {
    summaryMarkdown = event.fullMarkdown || summaryMarkdown;
    summaryJson = event.json;
    summaryDataAsOf =
      (event.json as { dataAsOf?: string } | null)?.dataAsOf ?? null;
    sendFrame(ctx.send, mapSummaryCompleteEvent(event));
  };

  const onError = async (event: Extract<SseEvent, { type: 'error' }>) => {
    logger.error(`${tag} ${event.sectionType ?? 'run'} error: ${event.message}`);
    sendFrame(ctx.send, mapErrorEvent(event));
    if (event.sectionType) {
      const acc = sectionAccs.get(event.sectionType);
      if (acc) {
        await persistence.persistSectionErrorById(acc.sectionId, event.message);
      } else {
        await persistence.persistSectionErrorByType(
          ctx.analysisId,
          event.sectionType,
          event.message,
        );
      }
      addFailed(event.sectionType);
    }
  };

  const queuedSectionIds = ctx.analysis.sections
    .filter((section) => section.status !== 'COMPLETED')
    .map((section) => section.id);
  await persistence.markQueuedSectionsInProgress(queuedSectionIds);

  const todayDate = new Date().toISOString().slice(0, 10);
  const marketProfile =
    ctx.analysis.stock.market === 'CN' ? getMarket('CN') ?? undefined : undefined;
  const marketDomainTiers = marketProfile?.domainTiers;
  const marketAllowedDomains = marketDomainTiers
    ? Object.keys(marketDomainTiers).filter((host) => marketDomainTiers[host] !== 'E')
    : undefined;
  const dimInput: DimensionInput = {
    symbol: ctx.analysis.stock.symbol,
    market: ctx.analysis.stock.market,
    locale: 'zh-CN',
    ...(ctx.analysis.stock.name ? { name: ctx.analysis.stock.name } : {}),
    ...(ctx.analysis.question ? { question: ctx.analysis.question } : {}),
    focusWindow: ctx.focusWindow,
  };

  const existingSnapshot = await ctx.prisma.analysisEvidenceSnapshot.findUnique({
    where: { analysisId: ctx.analysisId },
    select: { payload: true, degraded: true },
  });
  const evidencePackResult = existingSnapshot
    ? null
    : ctx.evidencePackService
      ? await ctx.evidencePackService.buildForAnalysis(ctx.analysis, ctx.signal)
      : null;
  capturedEvidencePack = (existingSnapshot?.payload ?? evidencePackResult?.pack) as
    | EvidencePackV2
    | undefined;
  snapshotPersisted = Boolean(existingSnapshot);
  if (existingSnapshot?.degraded || evidencePackResult?.fallbackUsed) {
    degradedSourceMark = 'WEB_SEARCH_FALLBACK';
  }
  if (capturedEvidencePack && !snapshotPersisted) {
    await persistEvidenceSnapshot(ctx.prisma, ctx.analysisId, capturedEvidencePack, {
      degraded: degradedSourceMark !== null,
      sourceMode: degradedSourceMark ? 'WEB_SEARCH_FALLBACK' : 'EVIDENCE_PACK',
    });
    snapshotPersisted = true;
  }

  const factory = ctx._streamFactory ?? defaultFactory;
  const gen = factory(ctx.provider, dimInput, {
    runId: `analysis-${ctx.analysisId}`,
    todayDate,
    mode: ctx.mode,
    focusWindow: ctx.focusWindow,
    waveMode: 'auto',
    signal: ctx.signal,
    ...(ctx.waveSemaphore ? { waveSemaphore: ctx.waveSemaphore } : {}),
    ...(marketProfile ? { marketProfile } : {}),
    ...(capturedEvidencePack ? { evidencePack: capturedEvidencePack } : {}),
    ...(existingResults.length > 0 ? { existingResults } : {}),
    recoverMissingEvidence: true,
    ...(marketAllowedDomains && marketAllowedDomains.length > 0
      ? { allowedDomains: marketAllowedDomains }
      : {}),
    ...(marketDomainTiers ? { domainTiers: marketDomainTiers } : {}),
  } as ComprehensiveOptions);

  try {
    while (true) {
      const next = await gen.next();
      if (next.done) break;
      const event = next.value;
      switch (event.type) {
        case 'evidence_pack_ready': await onEvidencePackReady(event); break;
        case 'section_skipped': await onSectionSkipped(event); break;
        case 'section_start': onSectionStart(event); break;
        case 'report_chunk': onReportChunk(event); break;
        case 'citation': onCitation(event); break;
        case 'report_complete': onReportComplete(event); break;
        case 'structured_data': onStructuredData(event); break;
        case 'web_search_warning': break;
        case 'section_complete': await onSectionComplete(event); break;
        case 'summary_chunk': onSummaryChunk(event); break;
        case 'summary_complete': onSummaryComplete(event); break;
        case 'cost_update': sendFrame(ctx.send, mapCostUpdateEvent(event)); break;
        case 'error': await onError(event); break;
        case 'done': {
          terminalStatus = event.status as AdapterResult['terminalStatus'];
          const trace = event.result?.trace;
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
            inputTokens:
              typeof trace?.tokensIn === 'number'
                ? trace.tokensIn
                : accumulatedInputTokens || null,
            outputTokens:
              typeof trace?.tokensOut === 'number'
                ? trace.tokensOut
                : accumulatedOutputTokens || null,
            doneEvent: event,
          });
          sendFrame(ctx.send, mapDoneEvent(ctx.analysisId, terminalStatus));
          break;
        }
      }
    }
  } catch (err) {
    const aborted =
      (err instanceof Error && /Abort/i.test(err.name)) ||
      ctx.signal?.aborted === true;
    if (aborted) {
      terminalStatus = 'CANCELLED';
      await persistence.persistRunCancelled({
        analysisId: ctx.analysisId,
        inputTokens: accumulatedInputTokens || null,
        outputTokens: accumulatedOutputTokens || null,
      });
      sendFrame(ctx.send, mapDoneEvent(ctx.analysisId, terminalStatus));
    } else {
      terminalStatus = 'FAILED';
      const message = err instanceof Error ? err.message : String(err);
      await persistence.persistRunFailed(ctx.analysisId, message);
      sendFrame(ctx.send, mapThrownError(message));
      sendFrame(ctx.send, mapDoneEvent(ctx.analysisId, terminalStatus));
    }
  }

  const orphanTypes = ctx.analysis.sections
    .map((section) => section.type)
    .filter(
      (type) =>
        !completedSectionTypes.has(type) && !failedSectionTypes.includes(type),
    );
  if (orphanTypes.length > 0) {
    await persistence.sweepOrphanSections({
      analysisId: ctx.analysisId,
      orphanTypes,
      terminalStatus,
    });
    for (const type of orphanTypes) addFailed(type);
  }

  return { terminalStatus, factConflictCount: 0, failedSectionTypes };
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
  pack: EvidencePackV2,
  options: { sourceMode: string; degraded: boolean },
) {
  const raw = pack as unknown as Record<string, any>;
  const availability = raw.dataAvailability ?? {};
  const missing = Array.isArray(availability.missing)
    ? availability.missing.map((item: any) =>
        typeof item === 'string' ? item : String(item?.field ?? 'unknown'),
      )
    : [];
  if (Array.isArray(availability.missingPrivateFields)) {
    for (const field of availability.missingPrivateFields) {
      if (typeof field === 'string' && !missing.includes(field)) missing.push(field);
    }
  }
  const capturedAt =
    typeof raw.capturedAt === 'string' ? raw.capturedAt : new Date().toISOString();
  const contentHash = createHash('sha256').update(canonicalJson(pack)).digest('hex');
  await prisma.analysisEvidenceSnapshot.create({
    data: {
      analysisId,
      schemaVersion: String(raw.schemaVersion ?? 'unknown'),
      evidencePackVersion: String(raw.schemaVersion ?? 'unknown'),
      capturedAt: new Date(capturedAt),
      dataAsOf: raw.dataAsOf ?? capturedAt,
      sourceMode: options.sourceMode,
      degraded: options.degraded,
      missingFields: missing,
      payload: pack as any,
      sourceSnapshots: Array.isArray(raw.citations) ? raw.citations : [],
      contentHash,
    },
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
