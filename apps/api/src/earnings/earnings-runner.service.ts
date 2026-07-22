import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  EARNINGS_EXTRACTION_SYSTEM_PROMPT,
  EARNINGS_EXTRACTION_PROMPT_VERSION,
  EARNINGS_MAX_OUTPUT_TOKENS,
  EARNINGS_SCHEMA_VERSION,
  buildEarningsExtractionUserPrompt,
} from './earnings-prompts';
import {
  EarningsCardPayloadSchema,
  EarningsExtractionSchema,
  EarningsGuidanceCandidateSchema,
  EarningsManagementClaimCandidateSchema,
  attachComparisons,
  attachEarningsBenchmarks,
  computeContentHash,
  computeUsd,
  financialsToComparableFacts,
  latestFinancialsToStructuredProjection,
  locateSourceSpan,
  reconcileEarningsFacts,
  structuredOutputWithRepair,
  verifyEarningsCandidates,
  type EarningsCardPayload,
  type EarningsFilingDescriptor,
  type GuidanceBenchmark,
  type MetricFact,
} from '@bourse/analysis';
import { Prisma, type EarningsEvent, type Filing, type Stock } from '@prisma/client';
import type { FinancialsPort } from '@bourse/analysis';
import { PrismaService } from '../prisma/prisma.service';
import {
  CN_FINANCIALS_PORT,
  US_FINANCIALS_PORT,
} from '../connectors/connectors.module';
import { ProviderFactoryService } from '../analysis/provider-factory.service';
import {
  type EarningsRunSource,
  type PreparedEarningsSource,
  type StructuredFallbackSource,
} from './earnings-source.service';
import { EarningsBudgetService } from './earnings-budget.service';
import { EarningsConsensusService } from './earnings-consensus.service';
import { EarningsNoticeService } from './earnings-notice.service';

type EarningsExtractionValue = ReturnType<typeof EarningsExtractionSchema.parse>;
const DEFAULT_EARNINGS_EXTRACTION_TIMEOUT_MS = 180_000;
const MAX_EARNINGS_EXTRACTION_TIMEOUT_MS = 600_000;

@Injectable()
export class EarningsRunnerService implements OnModuleInit {
  private readonly logger = new Logger(EarningsRunnerService.name);
  private readonly scheduled = new Set<string>();
  private readonly pending: string[] = [];
  private activeRuns = 0;
  private readonly concurrency: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly providerFactory: ProviderFactoryService,
    private readonly budget: EarningsBudgetService,
    @Inject(US_FINANCIALS_PORT) private readonly usFinancials: FinancialsPort,
    @Inject(CN_FINANCIALS_PORT) private readonly cnFinancials: FinancialsPort,
    private readonly consensus: EarningsConsensusService,
    private readonly notices: EarningsNoticeService,
  ) {
    this.concurrency = parseEarningsGenerationConcurrency(
      this.config.get<string>('EARNINGS_GENERATION_CONCURRENCY'),
    );
  }

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
        budgetReservedUsd: new Prisma.Decimal(0),
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
    if (this.scheduled.has(runId)) return;
    this.scheduled.add(runId);
    this.pending.push(runId);
    this.drain();
  }

  private drain(): void {
    while (this.activeRuns < this.concurrency && this.pending.length > 0) {
      const runId = this.pending.shift();
      if (!runId) return;
      this.activeRuns += 1;
      setImmediate(() => {
        void this.run(runId).finally(() => {
          this.activeRuns -= 1;
          this.scheduled.delete(runId);
          this.drain();
        });
      });
    }
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
      if (this.config.get<string>('EARNINGS_BRIEF_ENABLED')?.toLowerCase() === 'false') {
        throw new RunError('FEATURE_DISABLED', false, 'Earnings brief is disabled');
      }
      const source = parseSourceDescriptor(run.sourceDescriptor);
      if (source.kind === 'structuredFallback') {
        await this.completeStructuredFallback(runId, run.stock, source);
        return;
      }
      const [filing, parserDerivation] = await Promise.all([
        this.prisma.filing.findUnique({ where: { id: source.filingId } }),
        this.prisma.filingDerivation.findUnique({ where: { id: source.derivationId } }),
      ]);
      if (!filing || !parserDerivation) throw new RunError('SOURCE_NOT_PERSISTED', false);

      const providerName = this.config.get<string>('AI_PROVIDER') || 'claude';
      const provider = this.providerFactory.buildProvider(providerName);
      const model = provider.getUtilityModel();
      const extractionTimeoutMs = parseEarningsExtractionTimeoutMs(
        this.config.get<string>('EARNINGS_EXTRACTION_TIMEOUT_MS'),
      );
      const extractionKey = buildEarningsExtractionDerivationKey({
        filingId: filing.id,
        parserDerivationId: parserDerivation.id,
        sourceHash: parserDerivation.contentHash,
        model,
      });

      let extraction: EarningsExtractionValue;
      let inputTokens = run.inputTokens;
      let outputTokens = run.outputTokens;
      let costUsd = run.costUsd.toNumber();
      const cached = await this.prisma.filingDerivation.findUnique({
        where: { derivationKey: extractionKey },
      });
      if (cached?.extraction) {
        extraction = EarningsExtractionSchema.parse(cached.extraction);
      } else {
        const extractionPrompt = buildEarningsExtractionUserPrompt(
          {
            ...source,
            normalizedText: parserDerivation.normalizedText,
            pages: parsePages(parserDerivation.pages),
          },
          run.stock,
        );
        const reservation = await this.budget.reserve(
          runId,
          model,
          EARNINGS_EXTRACTION_SYSTEM_PROMPT,
          extractionPrompt,
          EARNINGS_MAX_OUTPUT_TOKENS,
        );
        if (!reservation.available) {
          await this.completeStructuredFallback(runId, run.stock, toFallbackSource(source, reservation.code));
          return;
        }
        let settled = false;
        let result;
        try {
          result = await structuredOutputWithRepair(
            provider,
            EARNINGS_EXTRACTION_SYSTEM_PROMPT,
            extractionPrompt,
            EarningsExtractionSchema,
            {
              maxTokens: EARNINGS_MAX_OUTPUT_TOKENS,
              signal: AbortSignal.timeout(extractionTimeoutMs),
            },
          );
          inputTokens += result.usage.tokensIn;
          outputTokens += result.usage.tokensOut;
          costUsd += computeUsd(
            result.model ?? model,
            result.usage.tokensIn,
            result.usage.tokensOut,
          );
          await this.budget.settle(runId, costUsd);
          settled = true;
        } catch (error) {
          if (!settled) {
            costUsd += reservation.reservedUsd;
            await this.budget.settle(runId, costUsd);
            settled = true;
          }
          if (isProviderFailure(error)) {
            await this.completeStructuredFallback(
              runId,
              run.stock,
              toFallbackSource(source, 'PROVIDER_UNAVAILABLE'),
              costUsd,
            );
            return;
          }
          throw error;
        } finally {
          // Provider failures do not always return usage. Charging the
          // conservative reservation keeps the hard daily cap intact.
          if (!settled) {
            costUsd += reservation.reservedUsd;
            await this.budget.settle(runId, costUsd);
          }
        }
        extraction = EarningsExtractionSchema.parse(result.data);
        await this.prisma.filingDerivation.upsert({
          where: { derivationKey: extractionKey },
          update: {},
          create: {
            filingId: filing.id,
            derivationKey: extractionKey,
            parserVersion: parserDerivation.parserVersion,
            modelVersion: result.model ?? model,
            promptVersion: EARNINGS_EXTRACTION_PROMPT_VERSION,
            schemaVersion: EARNINGS_SCHEMA_VERSION,
            status: 'COMPLETE',
            normalizedText: parserDerivation.normalizedText,
            contentHash: parserDerivation.contentHash,
            pages: parserDerivation.pages ?? undefined,
            extraction: extraction as unknown as Prisma.InputJsonValue,
          },
        });
      }

      const extractionDerivation = await this.prisma.filingDerivation.findUniqueOrThrow({
        where: { derivationKey: extractionKey },
      });
      await this.updateStage(runId, 'CHECK', { provider: providerName, model });
      const verified = verifyEarningsCandidates({
        candidates: extraction.facts,
        derivation: {
          id: extractionDerivation.id,
          filingId: filing.id,
          contentHash: extractionDerivation.contentHash,
          text: extractionDerivation.normalizedText,
          pages: parsePages(extractionDerivation.pages),
        },
        event: {
          periodEndOn: extraction.periodEndOn,
          periodType: extraction.periodType,
          reportingScope: extraction.reportingScope,
        },
      });
      if (verified.facts.length === 0) {
        throw new RunError('CHECK_REJECTED_ALL', true, 'All extracted facts failed consistency checks');
      }

      const event = await this.ensureEvent(run.stock, extraction);
      await this.prisma.earningsGenerationRun.update({
        where: { id: runId },
        data: { eventId: event.id },
      });
      const filingRelation = await this.linkFiling(event, filing);
      await this.extractAndPersistGuidance(
        run.stock,
        filing,
        extractionDerivation,
        extraction.guidance,
      );

      await this.updateStage(runId, 'RECONCILE');
      let facts = await this.reconcile(run.stock, verified.facts);
      facts = await this.attachPriorPeriodComparisons(event, facts);
      facts = attachEarningsBenchmarks({
        facts,
        periodType: extraction.periodType,
        filingPublishedAt: filing.publishedAt.toISOString(),
        guidance: await this.loadGuidanceBenchmarks(event, filing.publishedAt.toISOString()),
        consensus: await this.consensus.beforePublication(
          run.stock.id,
          extraction.periodEndOn,
          undefined,
          filing.publishedAt.toISOString(),
        ),
        consensusMaxAgeMs: this.consensus.maxAgeMs(),
      });

      await this.updateStage(runId, 'INTERPRET');
      const managementClaims = extraction.managementClaims.flatMap((rawClaim, index) => {
        const parsedClaim = EarningsManagementClaimCandidateSchema.safeParse(rawClaim);
        if (!parsedClaim.success) return [];
        const claim = parsedClaim.data;
        if (parsePages(extractionDerivation.pages)?.length && claim.sourcePage === undefined) return [];
        const span = locateSourceSpan(
          extractionDerivation.normalizedText,
          claim.sourceQuote,
          claim.sourcePage,
          parsePages(extractionDerivation.pages),
        );
        if (!span) return [];
        return [{
          id: computeContentHash({ text: `${filing.id}:${span.startOffset}:${claim.text}` }),
          text: claim.text,
          sourceSpan: {
            kind: 'filingSpan' as const,
            filingId: filing.id,
            derivationId: extractionDerivation.id,
            contentHash: extractionDerivation.contentHash,
            quote: span.quote,
            startOffset: span.startOffset,
            endOffset: span.endOffset,
            page: span.page,
            section: claim.sourceSection,
          },
          order: index,
        }];
      }).map(({ order: _order, ...claim }) => claim);

      const statusSummary = summarizeFacts(facts);
      const payload = EarningsCardPayloadSchema.parse({
        schemaVersion: EARNINGS_SCHEMA_VERSION,
        event: {
          instrumentId: `${run.stock.market}:${run.stock.symbol}`,
          periodEndOn: extraction.periodEndOn,
          periodType: extraction.periodType,
          fiscalYear: extraction.fiscalYear,
          fiscalQuarter: extraction.fiscalQuarter,
          reportingScope: extraction.reportingScope,
        },
        filing: {
          sourceKind: 'filing',
          filingId: filing.id,
          formType: filing.formType,
          title: filing.title,
          sourceUrl: filing.sourceUrl,
          publishedAt: filing.publishedAt.toISOString(),
          provider: filing.provider,
          unaudited: isUnaudited(filing.formType, filing.title, parserDerivation.normalizedText),
          relationType: filingRelation,
        },
        supportingFilings: [],
        facts,
        managementClaims,
        omittedFactCount: extraction.facts.length - verified.facts.length,
        statusSummary,
        generatedAt: new Date().toISOString(),
      });

      await this.updateStage(runId, 'PERSIST');
      const revision = await this.persistRevision(event, payload, model, inputTokens, outputTokens, costUsd, filingRelation);
      await this.notices.notify(
        run.stock.id,
        revision.cardPayload,
        revision.id,
        revision.supersededRevisionId,
        filingRelation === 'CORRECTS' ? 'CORRECTION' : revision.revisionNo === 1 ? 'NEW_CARD' : 'UPDATE',
      ).catch((error) => this.logger.warn(`earnings notice failed: ${String(error)}`));
      await this.prisma.earningsGenerationRun.update({
        where: { id: runId },
        data: {
          status: 'COMPLETED',
          stage: 'DONE',
          retryable: false,
          cardRevisionId: revision.id,
          provider: providerName,
          model,
          inputTokens,
          outputTokens,
          costUsd: new Prisma.Decimal(costUsd),
          completedAt: new Date(),
        },
      });
    } catch (error) {
      const runError = normalizeRunError(error);
      await this.budget.release(runId).catch(() => undefined);
      await this.prisma.earningsGenerationRun.update({
        where: { id: runId },
        data: {
          status: runError.code === 'BUDGET_EXHAUSTED' ? 'BUDGET_EXHAUSTED' : 'FAILED',
          retryable: runError.retryable,
          errorCode: runError.code,
          errorMessage: runError.message.slice(0, 1000),
          budgetReservedUsd: new Prisma.Decimal(0),
          completedAt: new Date(),
        },
      });
      this.logger.error(`earnings run ${runId} failed: ${runError.message}`);
    }
  }

  private async completeStructuredFallback(
    runId: string,
    stock: Stock,
    source: StructuredFallbackSource,
    actualCostUsd = 0,
  ): Promise<void> {
    await this.updateStage(runId, 'RECONCILE', { provider: source.provider, model: 'structured-only' });
    const port = stock.market === 'US' ? this.usFinancials : stock.market === 'CN' ? this.cnFinancials : null;
    if (!port) throw new RunError(source.reason, true, 'No structured financials source is available');
    let projection: ReturnType<typeof latestFinancialsToStructuredProjection>;
    try {
      const result = await port.fetchFinancials({
        instrumentId: `${stock.market}:${stock.symbol}`,
        deriveTTM: false,
      });
      projection = result.data ? latestFinancialsToStructuredProjection(result.data) : null;
    } catch (error) {
      throw new RunError(source.reason, true, `Structured financials unavailable: ${String(error)}`);
    }
    if (!projection || projection.facts.length === 0) {
      throw new RunError(source.reason, true, 'Structured financials do not contain a supported period');
    }
    const periodError = structuredFallbackPeriodError(
      source.expectedPeriodEndOn,
      projection.periodEndOn,
    );
    if (periodError) throw new RunError(periodError.code, periodError.retryable, periodError.message);

    const event = await this.ensureEventFromIdentity(stock, {
      periodEndOn: projection.periodEndOn,
      periodType: projection.periodType,
      fiscalYear: projection.fiscalYear,
      fiscalQuarter: projection.fiscalQuarter,
      reportingScope: 'consolidated',
    });
    await this.prisma.earningsGenerationRun.update({ where: { id: runId }, data: { eventId: event.id } });
    let facts = await this.attachPriorPeriodComparisons(event, projection.facts);
    facts = attachEarningsBenchmarks({
      facts,
      periodType: projection.periodType,
      filingPublishedAt: source.publishedAt,
      guidance: await this.loadGuidanceBenchmarks(event, source.publishedAt),
      consensus: await this.consensus.beforePublication(stock.id, projection.periodEndOn, undefined, source.publishedAt),
      consensusMaxAgeMs: this.consensus.maxAgeMs(),
    });
    const payload = EarningsCardPayloadSchema.parse({
      schemaVersion: EARNINGS_SCHEMA_VERSION,
      event: {
        instrumentId: `${stock.market}:${stock.symbol}`,
        periodEndOn: projection.periodEndOn,
        periodType: projection.periodType,
        fiscalYear: projection.fiscalYear,
        fiscalQuarter: projection.fiscalQuarter,
        reportingScope: 'consolidated',
      },
      filing: {
        sourceKind: 'structured_fallback',
        formType: source.formType,
        title: source.title,
        sourceUrl: source.sourceUrl,
        publishedAt: source.publishedAt,
        provider: source.provider,
          // A structured fallback has no reliable body-level audit marker.
          // Only explicit filing metadata may surface the disclaimer; the
          // fallback path itself must not imply that a filing is unaudited.
          unaudited: isUnaudited(source.formType, source.title ?? null, ''),
      },
      supportingFilings: [],
      facts,
      managementClaims: [],
      omittedFactCount: 0,
      statusSummary: summarizeFacts(facts),
      generatedAt: new Date().toISOString(),
    });
    await this.updateStage(runId, 'PERSIST', { provider: source.provider, model: 'structured-only' });
    const revision = await this.persistRevision(event, payload, 'structured-only', 0, 0, actualCostUsd, 'SUPPLEMENTS');
    await this.notices.notify(
      stock.id,
      revision.cardPayload,
      revision.id,
      revision.supersededRevisionId,
      revision.revisionNo === 1 ? 'NEW_CARD' : 'UPDATE',
    ).catch((error) => this.logger.warn(`earnings notice failed: ${String(error)}`));
    await this.prisma.earningsGenerationRun.update({
      where: { id: runId },
      data: {
        status: 'COMPLETED',
        stage: 'DONE',
        retryable: false,
        cardRevisionId: revision.id,
        provider: source.provider,
        model: 'structured-only',
        inputTokens: 0,
        outputTokens: 0,
        costUsd: new Prisma.Decimal(actualCostUsd),
        budgetReservedUsd: new Prisma.Decimal(0),
        completedAt: new Date(),
      },
    });
  }

  private ensureEventFromIdentity(
    stock: Stock,
    identity: {
      periodEndOn: string;
      periodType: EarningsExtractionValue['periodType'];
      fiscalYear: number;
      fiscalQuarter?: number;
      reportingScope: EarningsExtractionValue['reportingScope'];
    },
  ): Promise<EarningsEvent> {
    const reportingScope = scopeToPrisma(identity.reportingScope);
    return this.prisma.earningsEvent.upsert({
      where: {
        stockId_periodEndOn_periodType_reportingScope: {
          stockId: stock.id,
          periodEndOn: new Date(`${identity.periodEndOn}T00:00:00.000Z`),
          periodType: identity.periodType,
          reportingScope,
        },
      },
      update: {
        fiscalYear: identity.fiscalYear,
        fiscalQuarter: identity.fiscalQuarter ?? null,
      },
      create: {
        stockId: stock.id,
        periodEndOn: new Date(`${identity.periodEndOn}T00:00:00.000Z`),
        periodType: identity.periodType,
        reportingScope,
        fiscalYear: identity.fiscalYear,
        fiscalQuarter: identity.fiscalQuarter,
      },
    });
  }

  private async ensureEvent(stock: Stock, extraction: EarningsExtractionValue): Promise<EarningsEvent> {
    return this.ensureEventFromIdentity(stock, {
      periodEndOn: extraction.periodEndOn,
      periodType: extraction.periodType,
      fiscalYear: extraction.fiscalYear,
      fiscalQuarter: extraction.fiscalQuarter,
      reportingScope: extraction.reportingScope,
    });
  }

  private async linkFiling(event: EarningsEvent, filing: Filing): Promise<'SUPPLEMENTS' | 'CORRECTS' | 'SUPERSEDES'> {
    const existing = await this.prisma.earningsEventFiling.findMany({
      where: { eventId: event.id },
      include: { filing: { select: { formType: true, title: true } } },
    });
    const relationType = decideFilingRelation(filing, existing.map((row) => row.filing));
    await this.prisma.earningsEventFiling.upsert({
      where: { eventId_filingId: { eventId: event.id, filingId: filing.id } },
      update: { relationType },
      create: { eventId: event.id, filingId: filing.id, relationType },
    });
    return relationType;
  }

  private async reconcile(stock: Stock, facts: MetricFact[]): Promise<MetricFact[]> {
    const port = stock.market === 'US' ? this.usFinancials : stock.market === 'CN' ? this.cnFinancials : null;
    if (!port) return facts;
    try {
      const result = await port.fetchFinancials({
        instrumentId: `${stock.market}:${stock.symbol}`,
        deriveTTM: false,
      });
      if (!result.data) return facts;
      return reconcileEarningsFacts(facts, financialsToComparableFacts(result.data, facts));
    } catch (error) {
      this.logger.warn(`reconciliation unavailable for ${stock.market}:${stock.symbol}: ${String(error)}`);
      return facts;
    }
  }

  private async extractAndPersistGuidance(
    stock: Stock,
    filing: Filing,
    derivation: { id: string; contentHash: string; normalizedText: string; pages: Prisma.JsonValue | null },
    candidates: EarningsExtractionValue['guidance'],
  ): Promise<void> {
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
    }
  }

  private async loadGuidanceBenchmarks(
    event: EarningsEvent,
    filingPublishedAt: string,
  ): Promise<GuidanceBenchmark[]> {
    const publishedAt = new Date(filingPublishedAt);
    const rows = await this.prisma.earningsGuidance.findMany({
      where: {
        stockId: event.stockId,
        targetPeriodEndOn: event.periodEndOn,
        targetPeriodType: 'FY',
        issuedAt: { lt: publishedAt },
        supersededAt: null,
      },
      orderBy: { issuedAt: 'desc' },
    });
    return rows.map((row) => ({
      metricCode: row.metricCode as GuidanceBenchmark['metricCode'],
      value: { kind: 'range', min: row.valueMin.toString(), max: row.valueMax.toString() },
      unit: row.unit as GuidanceBenchmark['unit'],
      currency: row.currency ?? undefined,
      scale: row.scale,
      targetPeriodEndOn: row.targetPeriodEndOn.toISOString().slice(0, 10),
      targetPeriodType: 'FY' as const,
      accountingBasis: row.accountingBasis,
      consolidationScope: row.consolidationScope.toLowerCase() as GuidanceBenchmark['consolidationScope'],
      issuedAt: row.issuedAt.toISOString(),
      provider: row.provider,
      sourceUrl: row.sourceUrl,
      sourceSpan: row.sourceSpan as GuidanceBenchmark['sourceSpan'],
    }));
  }

  private async attachPriorPeriodComparisons(event: EarningsEvent, facts: MetricFact[]): Promise<MetricFact[]> {
    const prior = await this.prisma.earningsEvent.findFirst({
      where: {
        stockId: event.stockId,
        periodType: event.periodType,
        reportingScope: event.reportingScope,
        periodEndOn: { lt: event.periodEndOn },
        card: { isNot: null },
      },
      orderBy: { periodEndOn: 'desc' },
      include: { card: { include: { currentRevision: true } } },
    });
    if (!prior?.card?.currentRevision) return facts;
    const payload = EarningsCardPayloadSchema.safeParse(prior.card.currentRevision.payload);
    return payload.success ? attachComparisons(facts, payload.data.facts, 'YOY') : facts;
  }

  private async persistRevision(
    event: EarningsEvent,
    payload: EarningsCardPayload,
    model: string,
    inputTokens: number,
    outputTokens: number,
    costUsd: number,
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
      const advancesCurrent = true;
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
          schemaVersion: EARNINGS_SCHEMA_VERSION,
          promptVersion: EARNINGS_EXTRACTION_PROMPT_VERSION,
          model,
          payload: mergedPayload as unknown as Prisma.InputJsonValue,
          contentHash,
          inputTokens,
          outputTokens,
          costUsd: new Prisma.Decimal(costUsd),
        },
      });
      if (card.currentRevisionId && advancesCurrent) {
        await tx.earningsCardRevision.update({
          where: { id: card.currentRevisionId },
          data: { supersededAt: new Date() },
        });
      }
      if (advancesCurrent) {
        await tx.earningsCard.update({
          where: { id: card.id },
          data: { currentRevisionId: revision.id },
        });
      }
      return { ...revision, supersededRevisionId: card.currentRevisionId ?? undefined, cardPayload: mergedPayload };
    });
  }

  private updateStage(
    runId: string,
    stage: 'CHECK' | 'RECONCILE' | 'INTERPRET' | 'PERSIST',
    data: { provider?: string; model?: string } = {},
  ) {
    return this.prisma.earningsGenerationRun.update({ where: { id: runId }, data: { stage, ...data } });
  }
}

export function mergeEarningsCardPayload(
  current: EarningsCardPayload,
  candidate: EarningsCardPayload,
  relationType: 'SUPPLEMENTS' | 'CORRECTS' | 'SUPERSEDES',
): EarningsCardPayload {
  const currentFiles = [current.filing, ...current.supportingFilings].map((filing) => ({
    ...filing,
    relationType: filing.relationType ?? relationType,
  }));
  const candidateFile = { ...candidate.filing, relationType };
  const files = [...currentFiles, candidateFile].filter((filing, index, all) => {
    const key = filing.filingId ?? `${filing.sourceUrl}:${filing.publishedAt}`;
    return all.findIndex((other) => (other.filingId ?? `${other.sourceUrl}:${other.publishedAt}`) === key) === index;
  });
  const primary = choosePrimaryFiling(current.filing, candidateFile, relationType);
  const primaryKey = primary.filingId ?? `${primary.sourceUrl}:${primary.publishedAt}`;
  const supportingFilings = files.filter((filing) => (filing.filingId ?? `${filing.sourceUrl}:${filing.publishedAt}`) !== primaryKey);

  const facts = new Map<string, MetricFact>();
  for (const fact of current.facts) facts.set(factIdentity(fact), fact);
  for (const fact of candidate.facts) {
    const key = factIdentity(fact);
    const previous = facts.get(key);
    if (!previous || shouldReplaceFact(previous, fact, current, candidate, relationType)) {
      facts.set(key, fact);
    }
  }
  const comparisonBase = [...facts.values()].map((fact) => ({
    ...fact,
    comparisons: fact.comparisons.filter((comparison) => comparison.kind !== 'PREVIOUS_VERSION'),
  }));
  const mergedFacts = attachComparisons(comparisonBase, current.facts, 'PREVIOUS_VERSION').map((fact) => ({
    ...fact,
    comparisons: fact.comparisons.filter((comparison) => (
      comparison.kind !== 'PREVIOUS_VERSION' || comparison.absoluteDelta !== '0'
    )),
  }));
  const claims = [...current.managementClaims, ...candidate.managementClaims]
    .filter((claim, index, all) => all.findIndex((other) => other.id === claim.id) === index);
  return {
    ...candidate,
    filing: primary,
    supportingFilings,
    facts: mergedFacts,
    managementClaims: claims,
    omittedFactCount: Math.max(current.omittedFactCount, candidate.omittedFactCount),
    statusSummary: summarizeFacts(mergedFacts),
  };
}

function choosePrimaryFiling(
  current: EarningsFilingDescriptor,
  candidate: EarningsFilingDescriptor,
  relationType: 'SUPPLEMENTS' | 'CORRECTS' | 'SUPERSEDES',
): EarningsFilingDescriptor {
  if (relationType === 'CORRECTS' || relationType === 'SUPERSEDES') return candidate;
  const currentRank = filingAuthorityRank(current);
  const candidateRank = filingAuthorityRank(candidate);
  if (candidateRank > currentRank) return candidate;
  if (candidateRank === currentRank && new Date(candidate.publishedAt).getTime() > new Date(current.publishedAt).getTime()) {
    return candidate;
  }
  return current;
}

function shouldReplaceFact(
  previous: MetricFact,
  candidate: MetricFact,
  current: EarningsCardPayload,
  next: EarningsCardPayload,
  relationType: 'SUPPLEMENTS' | 'CORRECTS' | 'SUPERSEDES',
): boolean {
  if (relationType === 'CORRECTS' || relationType === 'SUPERSEDES') return true;
  const previousFiling = filingForFact(current, previous);
  const candidateFiling = filingForFact(next, candidate);
  return filingAuthorityRank(candidateFiling) >= filingAuthorityRank(previousFiling);
}

function filingForFact(payload: EarningsCardPayload, fact: MetricFact): EarningsFilingDescriptor {
  if (fact.provenance.kind !== 'filingSpan') return payload.filing;
  const filingId = fact.provenance.filingId;
  return [payload.filing, ...payload.supportingFilings].find((filing) => filing.filingId === filingId)
    ?? payload.filing;
}

function filingAuthorityRank(filing: EarningsFilingDescriptor): number {
  const form = filing.formType.toLowerCase();
  if (filing.relationType === 'CORRECTS') return 100;
  if (form === '10-k') return 90;
  if (form === '10-q') return 80;
  if (form === '8-k') return 60;
  if (form === 'preliminary') return 50;
  if (form === 'preview') return 40;
  return 30;
}

function factIdentity(fact: MetricFact): string {
  return JSON.stringify([
    fact.metricCode,
    fact.periodStartOn,
    fact.periodEndOn,
    fact.periodKind,
    fact.accumulation,
    fact.accountingBasis,
    fact.consolidationScope,
    fact.unit,
    fact.currency,
  ]);
}

function parseSourceDescriptor(value: Prisma.JsonValue): EarningsRunSource {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RunError('INVALID_SOURCE_DESCRIPTOR', false);
  }
  const source = value as Record<string, unknown>;
  const commonKeys = ['provider', 'sourceDocumentId', 'formType', 'sourceUrl', 'publishedAt'];
  for (const key of commonKeys) {
    if (typeof source[key] !== 'string' || !source[key]) throw new RunError('INVALID_SOURCE_DESCRIPTOR', false);
  }
  if (source.kind === 'structuredFallback') {
    if (!['BODY_UNREADABLE', 'LLM_DISABLED', 'BUDGET_EXHAUSTED', 'PROVIDER_UNAVAILABLE'].includes(String(source.reason))) {
      throw new RunError('INVALID_SOURCE_DESCRIPTOR', false);
    }
    if (source.expectedPeriodEndOn !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(String(source.expectedPeriodEndOn))) {
      throw new RunError('INVALID_SOURCE_DESCRIPTOR', false);
    }
    return source as unknown as StructuredFallbackSource;
  }
  for (const key of ['filingId', 'derivationId']) {
    if (typeof source[key] !== 'string' || !source[key]) throw new RunError('INVALID_SOURCE_DESCRIPTOR', false);
  }
  return { ...source, kind: 'filing' } as unknown as PreparedEarningsSource;
}

function toFallbackSource(
  source: PreparedEarningsSource,
  reason: StructuredFallbackSource['reason'],
): StructuredFallbackSource {
  return {
    kind: 'structuredFallback',
    provider: source.provider,
    sourceDocumentId: source.sourceDocumentId,
    sourceGroupId: source.sourceGroupId,
    formType: source.formType,
    title: source.title,
    sourceUrl: source.sourceUrl,
    publishedAt: source.publishedAt,
    ...(source.expectedPeriodEndOn ? { expectedPeriodEndOn: source.expectedPeriodEndOn } : {}),
    reason,
  };
}

function parsePages(value: Prisma.JsonValue | null): PreparedEarningsSource['pages'] {
  if (!Array.isArray(value)) return undefined;
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const page = item as Record<string, unknown>;
    return typeof page.page === 'number' && typeof page.startOffset === 'number' && typeof page.endOffset === 'number'
      ? [{ page: page.page, text: typeof page.text === 'string' ? page.text : '', startOffset: page.startOffset, endOffset: page.endOffset }]
      : [];
  });
}

function scopeToPrisma(scope: EarningsExtractionValue['reportingScope']) {
  return scope === 'consolidated' ? 'CONSOLIDATED' as const : scope === 'parent' ? 'PARENT' as const : 'UNKNOWN' as const;
}

function summarizeFacts(facts: MetricFact[]) {
  return facts.reduce(
    (summary, fact) => {
      summary.total += 1;
      if (fact.provenance.kind === 'structuredSource') summary.structuredOnly += 1;
      if (fact.reconcileStatus.status === 'reconciled') summary.reconciled += 1;
      if (fact.reconcileStatus.status === 'pending') summary.pending += 1;
      if (fact.reconcileStatus.status === 'conflicted') summary.conflicted += 1;
      return summary;
    },
    { total: 0, reconciled: 0, pending: 0, conflicted: 0, structuredOnly: 0 },
  );
}

export function decideFilingRelation(
  filing: Pick<Filing, 'formType' | 'title'>,
  existing: Array<Pick<Filing, 'formType' | 'title'>>,
): 'SUPPLEMENTS' | 'CORRECTS' | 'SUPERSEDES' {
  if (/\/A$/i.test(filing.formType) || /更正|修正|amend(?:ment|ed)?/i.test(filing.title ?? '')) return 'CORRECTS';
  if (existing.length === 0) return 'SUPPLEMENTS';
  const nextForm = filing.formType.toLowerCase();
  const isRegulatoryPair = existing.some((item) => {
    const priorForm = item.formType.toLowerCase();
    return (nextForm === '8-k' && /^(10-q|10-k)$/.test(priorForm))
      || (priorForm === '8-k' && /^(10-q|10-k)$/.test(nextForm));
  });
  if (isRegulatoryPair) return 'SUPPLEMENTS';
  const progression = ['preview', 'preliminary', '10-q', '10-k'];
  if (progression.includes(nextForm) || existing.some((item) => progression.includes(item.formType.toLowerCase()))) {
    return 'SUPERSEDES';
  }
  return 'SUPPLEMENTS';
}

export function isUnaudited(formType: string, title: string | null, text: string): boolean {
  return /preview|preliminary/i.test(formType) || /业绩预告|业绩快报|未经审计|unaudited/i.test(`${title ?? ''}\n${text.slice(0, 5000)}`);
}

interface GuidanceCandidateForSourceCheck {
  metricCode: string;
  value: { min: string; max: string };
  unit: string;
  scale: number;
}

/**
 * Guidance is a benchmark, not a free-form number. Keep it only when the
 * cited filing span contains the metric and either both range endpoints or an
 * explicit midpoint +/- percentage from which the endpoints were derived.
 */
export function guidanceSourceSupportsCandidate(
  quote: string,
  candidate: GuidanceCandidateForSourceCheck,
): boolean {
  if (!guidanceQuoteNamesMetric(quote, candidate.metricCode)) return false;
  const numbers = extractGuidanceNumbers(quote);
  // Candidate values preserve the source's displayed decimal position; scale
  // is applied only when persisting the normalized amount.
  const min = new Prisma.Decimal(candidate.value.min);
  const max = new Prisma.Decimal(candidate.value.max);
  if (numbers.some((value) => value.eq(min)) && numbers.some((value) => value.eq(max))) return true;

  const midpoint = min.add(max).div(2);
  if (!numbers.some((value) => value.eq(midpoint))) return false;
  const spreadPercentage = max.sub(min).div(midpoint).div(2).mul(100);
  return numbers.some((value) => value.sub(spreadPercentage).abs().lte('0.05'))
    && /(?:\+\/?[-\s]*|plus\s+or\s+minus|上下浮动|增减|波动)[^\d]{0,12}\d+(?:\.\d+)?\s*%/i.test(quote);
}

function guidanceQuoteNamesMetric(quote: string, metricCode: string): boolean {
  const patterns: Record<string, RegExp[]> = {
    revenue: [/\brevenue\b/i, /\bsales\b/i, /营业收入|营业总收入/],
    operatingIncome: [/operating (?:income|profit)/i, /营业利润/],
    netIncome: [/\bnet income\b|\bnet profit\b/i, /净利润/],
    netIncomeAttrib: [/net income attributable/i, /归母净利润|归属于.*股东.*净利润/],
    epsBasic: [/basic earnings per share|basic eps/i, /基本每股收益/],
    epsDiluted: [/diluted earnings per share|diluted eps/i, /稀释每股收益/],
    grossProfit: [/gross profit/i, /毛利润/],
    grossMargin: [/gross margin/i, /毛利率/],
    operatingCashFlow: [/cash .*operating activities|operating cash flow/i, /经营活动.*现金流量净额/],
    capitalExpenditures: [/capital expenditure|property.*equipment/i, /资本开支|购建固定资产/],
    freeCashFlow: [/free cash flow/i, /自由现金流/],
  };
  return (patterns[metricCode] ?? []).some((pattern) => pattern.test(quote));
}

function extractGuidanceNumbers(quote: string): Prisma.Decimal[] {
  const matches = quote.match(/\(?[-+]?\s*(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?\)?/g) ?? [];
  return matches.flatMap((raw) => {
    const negative = raw.startsWith('(') && raw.endsWith(')');
    try {
      const value = new Prisma.Decimal(raw.replace(/[(),\s]/g, ''));
      return [negative ? value.negated() : value];
    } catch {
      return [];
    }
  });
}

class RunError extends Error {
  constructor(
    public readonly code: string,
    public readonly retryable: boolean,
    message?: string,
  ) {
    super(message ?? code);
  }
}

function normalizeRunError(error: unknown): RunError {
  if (error instanceof RunError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (message === 'INVALID_BUDGET_CONFIG') return new RunError(message, false);
  return new RunError('GENERATION_FAILED', true, message);
}

function isProviderFailure(error: unknown): boolean {
  return !(error instanceof RunError);
}

export function parseEarningsExtractionTimeoutMs(value: string | undefined): number {
  if (value === undefined || value.trim() === '') return DEFAULT_EARNINGS_EXTRACTION_TIMEOUT_MS;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1_000 || parsed > MAX_EARNINGS_EXTRACTION_TIMEOUT_MS) {
    throw new RunError(
      'INVALID_EARNINGS_TIMEOUT_CONFIG',
      false,
      `EARNINGS_EXTRACTION_TIMEOUT_MS must be an integer between 1000 and ${MAX_EARNINGS_EXTRACTION_TIMEOUT_MS}`,
    );
  }
  return parsed;
}

export function parseEarningsGenerationConcurrency(value: string | undefined): number {
  if (value === undefined || value.trim() === '') return 4;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 32) {
    throw new RunError(
      'INVALID_EARNINGS_CONCURRENCY_CONFIG',
      false,
      'EARNINGS_GENERATION_CONCURRENCY must be an integer between 1 and 32',
    );
  }
  return parsed;
}

export function buildEarningsExtractionDerivationKey(input: {
  filingId: string;
  parserDerivationId: string;
  sourceHash: string;
  model: string;
}): string {
  return computeContentHash({
    text: JSON.stringify({
      ...input,
      promptVersion: EARNINGS_EXTRACTION_PROMPT_VERSION,
      schemaVersion: EARNINGS_SCHEMA_VERSION,
    }),
  });
}

export function structuredFallbackPeriodError(
  expectedPeriodEndOn: string | undefined,
  structuredPeriodEndOn: string,
): { code: string; retryable: boolean; message: string } | null {
  if (!expectedPeriodEndOn) {
    return {
      code: 'STRUCTURED_PERIOD_UNCONFIRMED',
      retryable: false,
      message: 'The filing does not expose a period-of-report date, so structured fallback cannot be matched safely',
    };
  }
  if (structuredPeriodEndOn !== expectedPeriodEndOn) {
    return {
      code: 'STRUCTURED_PERIOD_MISMATCH',
      retryable: true,
      message: `Structured period ${structuredPeriodEndOn} does not match filing period ${expectedPeriodEndOn}`,
    };
  }
  return null;
}
