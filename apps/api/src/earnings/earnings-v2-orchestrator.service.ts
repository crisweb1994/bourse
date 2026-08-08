import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, type EarningsEvent, type Filing, type Stock } from '@prisma/client';
import {
  computeContentHash,
  EarningsCardPayloadSchema,
  EarningsGuidanceCandidateSchema,
  EarningsNarrativeExtractionSchema,
  locateSourceSpan,
  structuredOutputWithRepair,
  type EarningsCardPayload,
  type EarningsNarrativeExtraction,
} from '@bourse/analysis';
import { PrismaService } from '../prisma/prisma.service';
import { BoundedTaskQueue } from '../common/bounded-task-queue';
import { ProviderFactoryService } from '../analysis/provider-factory.service';
import {
  EARNINGS_EXTRACTION_SYSTEM_PROMPT,
  EARNINGS_MAX_OUTPUT_TOKENS,
  buildEarningsExtractionUserPrompt,
} from './earnings-prompts';
import {
  decideFilingRelation,
  guidanceSourceSupportsCandidate,
  isUnaudited,
  mergeEarningsCardPayload,
  normalizeManagementClaimCandidate,
  parsePages,
  parseSourceDescriptor,
} from './earnings-common';
import type { PreparedEarningsSource } from './earnings-source.service';
import { EarningsNoticeService } from './earnings-notice.service';
import { StructuredSelectionService } from './structured-selection.service';
import {
  buildV2FinancialsConnector,
  EarningsV2RunnerService,
  resolveV2IdentityWithProviderPeriods,
  type V2LaneIdentity,
  type StructuredProviderResult,
} from './earnings-v2-runner.service';
import {
  buildV2CardPayload,
  buildV2FilingDescriptor,
  type V2ManagementClaim,
  type V2SupplementalNonGaap,
} from './earnings-v2-card';

const V2_CARD_SCHEMA_VERSION = 'earnings-v2';
const V2_NARRATIVE_PROMPT_VERSION = 'earnings-narrative-v1';
const V2_NARRATIVE_SCHEMA_VERSION = 'earnings-narrative-v1';
const EXTRACTION_TIMEOUT_MS = 180_000;

/**
 * Earnings v2 编排器（docs/structured-first-earnings-architecture.md §11）。
 *
 * structured lane 与 document lane 并行、互不阻塞：
 * - structured lane：v2 connector → 快照 → selector → selection；
 * - document lane：narrative-only 抽取（guidance/claims/non-GAAP，带原文锚点）；
 * - merge 时文档 lane 无权写入 core actual（schema 第一道边界 +
 *   buildV2CardPayload 只接收 structured facts）。
 * 文档不可读 → narrative unavailable，不拖垮数字卡；无身份 → IDENTITY_UNKNOWN 重试。
 */

@Injectable()
export class EarningsV2OrchestratorService implements OnModuleInit {
  private readonly logger = new Logger(EarningsV2OrchestratorService.name);
  private readonly queue = new BoundedTaskQueue<string>({
    concurrency: 4,
    execute: (runId) => this.run(runId),
  });

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly selectionService: StructuredSelectionService,
    private readonly structuredLane: EarningsV2RunnerService,
    private readonly notices: EarningsNoticeService,
    private readonly providerFactory: ProviderFactoryService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.prisma.earningsGenerationRun.updateMany({
      where: { status: 'RUNNING' },
      data: {
        status: 'QUEUED',
        stage: 'DISCOVER',
        attempt: { increment: 1 },
        retryable: true,
        errorCode: 'SERVER_RESTARTED',
        errorMessage: 'Server restarted; generation was safely requeued',
        startedAt: null,
        completedAt: null,
      },
    });
    const queued = await this.prisma.earningsGenerationRun.findMany({
      where: { status: 'QUEUED' },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
    });
    for (const run of queued) this.schedule(run.id);
  }

  schedule(runId: string): void {
    this.queue.schedule(runId);
  }

  async run(runId: string): Promise<void> {
    const claimed = await this.prisma.earningsGenerationRun.updateMany({
      where: { id: runId, status: 'QUEUED' },
      data: { status: 'RUNNING', stage: 'EXTRACT', startedAt: new Date() },
    });
    if (claimed.count === 0) return;
    try {
      const run = await this.prisma.earningsGenerationRun.findUnique({
        where: { id: runId },
        include: { stock: true },
      });
      if (!run) return;
      const source = parseSourceDescriptor(run.sourceDescriptor);
      if (source.kind !== 'filing') {
        throw new V2RunError('SOURCE_NOT_SUPPORTED', false, `v2 runner only handles filing sources; got ${source.kind}`);
      }
      const [filing, parserDerivation] = await Promise.all([
        this.prisma.filing.findUnique({ where: { id: source.filingId } }),
        this.prisma.filingDerivation.findUnique({ where: { id: source.derivationId } }),
      ]);
      if (!filing || !parserDerivation) throw new V2RunError('SOURCE_NOT_PERSISTED', false);

      const providerName = this.config.get<string>('AI_PROVIDER') || 'claude';
      const provider = this.providerFactory.buildProvider(providerName);
      const model = provider.getUtilityModel();

      // ---- Provider 与公告文本并行 ----
      // Provider 先拿完整 periods；公告文本只负责叙事和必要的身份提示，
      // 不再在 Provider 调用前把核心数字判成 unsupported。
      const providerConnector = buildV2FinancialsConnector(run.stock.market);
      const [narrative, providerResult] = await Promise.all([
        this.runDocumentLane(run.stock, source, filing, parserDerivation, provider, model),
        providerConnector
          ? this.structuredLane.fetchProviderFinancials({ stock: run.stock, connector: providerConnector })
          : Promise.resolve(null),
      ]);

      // ---- 事件身份 ----
      const identity = resolveV2IdentityWithProviderPeriods(
        source,
        narrative?.extraction.eventIdentityHints,
        filing,
        providerResult?.data?.periods ?? [],
      );
      if (!identity.identity) {
        throw new V2RunError('IDENTITY_UNKNOWN', true, identity.diagnostics.join('; '));
      }
      const event = await this.ensureEventFromIdentity(run.stock, identity.identity);
      const structured = await this.runStructuredLaneSafe(
        runId,
        run.stock,
        event.id,
        identity.identity,
        providerConnector,
        providerResult,
        filing,
      );
      const filingRelation = await this.linkFiling(event, filing);
      await this.prisma.earningsGenerationRun.update({
        where: { id: runId },
        data: { eventId: event.id },
      });

      // ---- 持久化 guidance / claims / supplemental ----
      let guidanceCount = 0;
      if (narrative) {
        guidanceCount = await this.extractAndPersistGuidance(
          run.stock,
          filing,
          parserDerivation,
          narrative.extraction.guidance,
        );
      }
      const claims = narrative ? this.buildClaims(filing, parserDerivation, narrative.extraction) : [];
      const supplemental = narrative
        ? this.buildSupplemental(filing, parserDerivation, narrative.extraction)
        : [];

      // ---- 卡片组装 ----
      const facts =
        structured.selection.status === 'ready' || structured.selection.status === 'ambiguous'
          ? structured.selection.facts
          : [];
      const payload = buildV2CardPayload({
        schemaVersion: V2_CARD_SCHEMA_VERSION,
        event: {
          instrumentId: `${run.stock.market}:${run.stock.symbol}`,
          periodEndOn: event.periodEndOn.toISOString().slice(0, 10),
          periodType: identity.identity.periodType,
          fiscalYear: event.fiscalYear,
          reportingScope: event.reportingScope.toLowerCase() as 'consolidated' | 'parent' | 'unknown',
        },
        filing: buildV2FilingDescriptor({
          filingId: filing.id,
          formType: filing.formType,
          title: filing.title,
          sourceUrl: filing.sourceUrl,
          publishedAt: filing.publishedAt.toISOString(),
          provider: filing.provider,
          language: filing.language,
          unaudited: isUnaudited(filing.formType, filing.title, parserDerivation.normalizedText),
          relationType: filingRelation,
        }),
        facts,
        selection: structured.selection,
        managementClaims: claims,
        supplementalNonGaap: supplemental,
        narrativeStatus: narrative ? 'ready' : 'unavailable',
        guidanceStatus: guidanceCount > 0 ? 'ready' : 'none_reported',
        generatedAt: new Date().toISOString(),
      });

      const revision = await this.persistV2Revision(event, payload, model, 0, 0, filingRelation);
      await this.notices
        .notify(
          run.stock.id,
          revision.cardPayload,
          revision.id,
          revision.supersededRevisionId,
          filingRelation === 'CORRECTS' ? 'CORRECTION' : revision.revisionNo === 1 ? 'NEW_CARD' : 'UPDATE',
        )
        .catch((error) => this.logger.warn(`earnings v2 notice failed: ${String(error)}`));

      await this.prisma.earningsGenerationRun.update({
        where: { id: runId },
        data: {
          status: 'COMPLETED',
          stage: 'DONE',
          retryable: false,
          cardRevisionId: revision.id,
          provider: providerName,
          model,
          inputTokens: 0,
          outputTokens: 0,
          completedAt: new Date(),
        },
      });
    } catch (error) {
      const runError = normalizeV2RunError(error);
      await this.prisma.earningsGenerationRun.update({
        where: { id: runId },
        data: {
          status: 'FAILED',
          retryable: runError.retryable,
          errorCode: runError.code,
          errorMessage: runError.message.slice(0, 1000),
          completedAt: new Date(),
        },
      });
      this.logger.error(`earnings v2 run ${runId} failed: ${runError.message}`);
    }
  }

  /** structured lane 独立容错：失败不拖垮 document lane，落 unsupported + 默认重试。 */
  private async runStructuredLaneSafe(
    runId: string,
    stock: Stock,
    eventId: string,
    identity: V2LaneIdentity,
    connector: ReturnType<typeof buildV2FinancialsConnector>,
    providerResult: StructuredProviderResult | null,
    filing: Filing,
  ) {
    if (!connector) {
      return {
        selection: unsupportedSelection('unsupported_market', [`no v2 connector for ${stock.market}`]),
      };
    }
    // 事件由编排器统一 ensure；structured lane 仅在事件存在时落 selection。
    await this.prisma.earningsGenerationRun.update({
      where: { id: runId },
      data: { eventId },
    });
    const knowledgeCutoffAt = new Date().toISOString();
    return this.structuredLane.runStructuredLane({
      eventId,
      stock,
      identity,
      eventPublishedAt: filing.publishedAt.toISOString(),
      knowledgeCutoffAt,
      connector,
      ...(providerResult ? { providerResult } : {}),
      now: knowledgeCutoffAt,
    });
  }

  /** document lane：narrative-only 抽取，带 derivation 缓存；失败返回 null（unavailable）。 */
  private async runDocumentLane(
    stock: Stock,
    source: PreparedEarningsSource,
    filing: Filing,
    parserDerivation: { id: string; contentHash: string; normalizedText: string; pages: Prisma.JsonValue | null },
    provider: ReturnType<ProviderFactoryService['buildProvider']>,
    model: string,
  ): Promise<{ extraction: EarningsNarrativeExtraction; derivationId: string } | null> {
    try {
      const extractionKey = buildNarrativeDerivationKey({
        filingId: filing.id,
        parserDerivationId: parserDerivation.id,
        sourceHash: parserDerivation.contentHash,
        model,
      });
      const cached = await this.prisma.filingDerivation.findUnique({
        where: { derivationKey: extractionKey },
      });
      let extraction: EarningsNarrativeExtraction;
      if (cached?.extraction) {
        extraction = EarningsNarrativeExtractionSchema.parse(cached.extraction);
      } else {
        const extractionPrompt = buildEarningsExtractionUserPrompt(
          {
            ...source,
            normalizedText: parserDerivation.normalizedText,
            pages: parsePages(parserDerivation.pages),
          },
          stock,
        );
        const result = await structuredOutputWithRepair(
          provider,
          EARNINGS_EXTRACTION_SYSTEM_PROMPT,
          extractionPrompt,
          EarningsNarrativeExtractionSchema,
          {
            maxTokens: EARNINGS_MAX_OUTPUT_TOKENS,
            signal: AbortSignal.timeout(EXTRACTION_TIMEOUT_MS),
          },
        );
        extraction = EarningsNarrativeExtractionSchema.parse(result.data);
        await this.prisma.filingDerivation.upsert({
          where: { derivationKey: extractionKey },
          update: {},
          create: {
            filingId: filing.id,
            derivationKey: extractionKey,
            parserVersion: parserDerivation.contentHash,
            modelVersion: result.model ?? model,
            promptVersion: V2_NARRATIVE_PROMPT_VERSION,
            schemaVersion: V2_NARRATIVE_SCHEMA_VERSION,
            status: 'COMPLETE',
            normalizedText: parserDerivation.normalizedText,
            contentHash: parserDerivation.contentHash,
            pages: parserDerivation.pages ?? undefined,
            extraction: extraction as unknown as Prisma.InputJsonValue,
          },
        });
      }
      const derivation = await this.prisma.filingDerivation.findUniqueOrThrow({
        where: { derivationKey: extractionKey },
      });
      return { extraction, derivationId: derivation.id };
    } catch (error) {
      this.logger.warn(`earnings v2 narrative lane failed for ${stock.symbol}: ${String(error)}`);
      return null;
    }
  }

  private buildClaims(
    filing: Filing,
    parserDerivation: { id: string; normalizedText: string; pages: Prisma.JsonValue | null },
    extraction: EarningsNarrativeExtraction,
  ): V2ManagementClaim[] {
    return extraction.managementClaims.flatMap((rawClaim) => {
      const parsedClaim = normalizeManagementClaimCandidate(rawClaim);
      if (!parsedClaim.success) return [];
      const claim = parsedClaim.data;
      if (parsePages(parserDerivation.pages)?.length && claim.sourcePage === undefined) return [];
      const span = locateSourceSpan(
        parserDerivation.normalizedText,
        claim.sourceQuote,
        claim.sourcePage,
        parsePages(parserDerivation.pages),
      );
      if (!span) return [];
      return [
        {
          id: computeContentHash({ text: `${filing.id}:${span.startOffset}:${claim.text}` }),
          text: claim.text,
          sourceSpan: {
            kind: 'filingSpan',
            filingId: filing.id,
            derivationId: parserDerivation.id,
            contentHash: computeContentHash({ text: parserDerivation.normalizedText }),
            quote: span.quote,
            startOffset: span.startOffset,
            endOffset: span.endOffset,
            page: span.page,
            section: claim.sourceSection,
          },
        },
      ];
    });
  }

  private buildSupplemental(
    filing: Filing,
    parserDerivation: { id: string; normalizedText: string; pages: Prisma.JsonValue | null },
    extraction: EarningsNarrativeExtraction,
  ): V2SupplementalNonGaap[] {
    return extraction.supplementalNonGaapFacts.flatMap((candidate) => {
      const span = locateSourceSpan(
        parserDerivation.normalizedText,
        candidate.sourceQuote,
        candidate.sourcePage,
        parsePages(parserDerivation.pages),
      );
      if (!span) return [];
      return [
        {
          metricLabel: candidate.metricLabel,
          value: candidate.value,
          unit: candidate.unit,
          ...(candidate.currency ? { currency: candidate.currency } : {}),
          targetPeriodEndOn: candidate.targetPeriodEndOn,
          ...(candidate.reconciliationContext
            ? { reconciliationContext: candidate.reconciliationContext }
            : {}),
          sourceSpan: {
            kind: 'filingSpan',
            filingId: filing.id,
            derivationId: parserDerivation.id,
            contentHash: computeContentHash({ text: parserDerivation.normalizedText }),
            quote: span.quote,
            startOffset: span.startOffset,
            endOffset: span.endOffset,
            page: span.page,
            section: candidate.sourceSection,
          },
        },
      ];
    });
  }

  private async extractAndPersistGuidance(
    stock: Stock,
    filing: Filing,
    derivation: { id: string; contentHash: string; normalizedText: string; pages: Prisma.JsonValue | null },
    candidates: EarningsNarrativeExtraction['guidance'],
  ): Promise<number> {
    let count = 0;
    for (const rawCandidate of candidates) {
      const parsedCandidate = EarningsGuidanceCandidateSchema.safeParse(rawCandidate);
      if (!parsedCandidate.success) continue;
      const candidate = parsedCandidate.data;
      if (parsePages(derivation.pages)?.length && candidate.sourcePage === undefined) continue;
      const span = locateSourceSpan(
        derivation.normalizedText,
        candidate.sourceQuote,
        candidate.sourcePage,
        parsePages(derivation.pages),
      );
      if (!span || !guidanceSourceSupportsCandidate(span.quote, candidate)) continue;
      const valueMin = new Prisma.Decimal(candidate.value.min).mul(candidate.scale);
      const valueMax = new Prisma.Decimal(candidate.value.max).mul(candidate.scale);
      const sourceSpan = {
        kind: 'filingSpan' as const,
        filingId: filing.id,
        derivationId: derivation.id,
        contentHash: derivation.contentHash,
        quote: span.quote,
        startOffset: span.startOffset,
        endOffset: span.endOffset,
        page: span.page,
        section: candidate.sourceSection,
      };
      const dedupeKey = computeContentHash({
        text: JSON.stringify({
          filingId: filing.id,
          metricCode: candidate.metricCode,
          targetPeriodEndOn: candidate.targetPeriodEndOn,
          startOffset: span.startOffset,
          valueMin: valueMin.toString(),
          valueMax: valueMax.toString(),
        }),
      });
      await this.prisma.earningsGuidance.updateMany({
        where: {
          stockId: stock.id,
          metricCode: candidate.metricCode,
          targetPeriodEndOn: new Date(`${candidate.targetPeriodEndOn}T00:00:00.000Z`),
          targetPeriodType: 'FY',
          supersededAt: null,
          issuedAt: { lt: filing.publishedAt },
        },
        data: { supersededAt: new Date() },
      });
      await this.prisma.earningsGuidance.upsert({
        where: { dedupeKey },
        update: {},
        create: {
          dedupeKey,
          stockId: stock.id,
          filingId: filing.id,
          metricCode: candidate.metricCode,
          targetPeriodEndOn: new Date(`${candidate.targetPeriodEndOn}T00:00:00.000Z`),
          targetPeriodType: 'FY',
          valueMin,
          valueMax,
          unit: candidate.unit,
          currency: candidate.currency,
          scale: 1,
          accountingBasis: candidate.accountingBasis,
          consolidationScope: scopeToPrisma(candidate.consolidationScope),
          issuedAt: filing.publishedAt,
          provider: filing.provider,
          sourceUrl: filing.sourceUrl,
          sourceSpan,
        },
      });
      count += 1;
    }
    return count;
  }

  private async ensureEventFromIdentity(
    stock: Stock,
    identity: V2LaneIdentity,
  ): Promise<EarningsEvent> {
    return this.prisma.earningsEvent.upsert({
      where: {
        stockId_periodEndOn_periodType_reportingScope: {
          stockId: stock.id,
          periodEndOn: new Date(`${identity.periodEndOn}T00:00:00.000Z`),
          periodType: toPrismaPeriodType(identity.periodType),
          reportingScope: 'CONSOLIDATED',
        },
      },
      update: {
        fiscalYear: identity.fiscalYear ?? Number(identity.periodEndOn.slice(0, 4)),
      },
      create: {
        stockId: stock.id,
        periodEndOn: new Date(`${identity.periodEndOn}T00:00:00.000Z`),
        periodType: toPrismaPeriodType(identity.periodType),
        reportingScope: 'CONSOLIDATED',
        fiscalYear: identity.fiscalYear ?? Number(identity.periodEndOn.slice(0, 4)),
      },
    });
  }

  private async linkFiling(
    event: EarningsEvent,
    filing: Filing,
  ): Promise<'SUPPLEMENTS' | 'CORRECTS' | 'SUPERSEDES'> {
    const existing = await this.prisma.earningsEventFiling.findMany({
      where: { eventId: event.id },
      include: { filing: { select: { formType: true, title: true } } },
    });
    const relationType = decideFilingRelation(
      filing,
      existing.map((row) => row.filing),
    );
    await this.prisma.earningsEventFiling.upsert({
      where: { eventId_filingId: { eventId: event.id, filingId: filing.id } },
      update: { relationType },
      create: { eventId: event.id, filingId: filing.id, relationType },
    });
    return relationType;
  }

  private async persistV2Revision(
    event: EarningsEvent,
    payload: EarningsCardPayload,
    model: string,
    inputTokens: number,
    outputTokens: number,
    relationType: 'SUPPLEMENTS' | 'CORRECTS' | 'SUPERSEDES',
  ) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${event.id}))`;
      const card = await tx.earningsCard.upsert({
        where: { eventId: event.id },
        update: {},
        create: { eventId: event.id },
        include: { currentRevision: true },
      });
      const currentPayload = card.currentRevision
        ? EarningsCardPayloadSchema.safeParse(card.currentRevision.payload)
        : null;
      const mergedPayload = currentPayload?.success
        ? mergeEarningsCardPayload(currentPayload.data, payload, relationType)
        : payload;
      const { generatedAt: _generatedAt, ...stablePayload } = mergedPayload;
      const contentHash = computeContentHash({ text: JSON.stringify(stablePayload) });
      if (card.currentRevision?.contentHash === contentHash) {
        return { ...card.currentRevision, supersededRevisionId: undefined, cardPayload: mergedPayload };
      }
      const latest = await tx.earningsCardRevision.findFirst({
        where: { cardId: card.id },
        orderBy: { revisionNo: 'desc' },
        select: { revisionNo: true },
      });
      const revision = await tx.earningsCardRevision.create({
        data: {
          cardId: card.id,
          revisionNo: (latest?.revisionNo ?? 0) + 1,
          status: mergedPayload.managementClaims.length > 0 ? 'COMPLETE' : 'PARTIAL',
          schemaVersion: V2_CARD_SCHEMA_VERSION,
          promptVersion: V2_NARRATIVE_PROMPT_VERSION,
          model,
          payload: mergedPayload as unknown as Prisma.InputJsonValue,
          contentHash,
          inputTokens,
          outputTokens,
        },
      });
      if (card.currentRevisionId) {
        await tx.earningsCardRevision.update({
          where: { id: card.currentRevisionId },
          data: { supersededAt: new Date() },
        });
      }
      await tx.earningsCard.update({
        where: { id: card.id },
        data: { currentRevisionId: revision.id },
      });
      return { ...revision, supersededRevisionId: card.currentRevisionId ?? undefined, cardPayload: mergedPayload };
    });
  }
}

export function buildNarrativeDerivationKey(input: {
  filingId: string;
  parserDerivationId: string;
  sourceHash: string;
  model: string;
}): string {
  return computeContentHash({
    text: JSON.stringify({
      ...input,
      promptVersion: V2_NARRATIVE_PROMPT_VERSION,
      schemaVersion: V2_NARRATIVE_SCHEMA_VERSION,
    }),
  });
}

function unsupportedSelection(reason: string, diagnostics: string[]) {
  return {
    status: 'unsupported' as const,
    reason,
    diagnostics: {
      expected: {} as never,
      candidatePeriods: [],
      rejected: diagnostics.map((message) => ({ reason: message })),
      warnings: diagnostics,
    },
  };
}

function scopeToPrisma(scope: 'consolidated' | 'parent' | 'unknown') {
  return scope === 'consolidated' ? ('CONSOLIDATED' as const) : scope === 'parent' ? ('PARENT' as const) : ('UNKNOWN' as const);
}

function toPrismaPeriodType(periodType: V2LaneIdentity['periodType']) {
  return periodType === '9M' ? ('NINE_M' as const) : periodType;
}

class V2RunError extends Error {
  constructor(
    public readonly code: string,
    public readonly retryable: boolean,
    message?: string,
  ) {
    super(message ?? code);
  }
}

function normalizeV2RunError(error: unknown): V2RunError {
  if (error instanceof V2RunError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new V2RunError('GENERATION_FAILED', true, message);
}
