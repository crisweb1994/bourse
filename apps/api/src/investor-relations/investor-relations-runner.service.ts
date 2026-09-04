import type {
  FilingPage,
} from '@bourse/market-data';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { computeContentHash } from '@bourse/market-data';
import { INVESTOR_RELATIONS_MAX_OUTPUT_TOKENS, INVESTOR_RELATIONS_PROMPT_VERSION, INVESTOR_RELATIONS_SCHEMA_VERSION, INVESTOR_RELATIONS_SYSTEM_PROMPT, InvestorRelationsExtractionSchema, InvestorRelationsRevisionPayloadSchema, buildInvestorRelationsUserPrompt, locateSourceSpan, structuredOutputWithRepair, type InvestorRelationsRevisionPayload } from '@bourse/analysis';
import { Prisma, type Filing, type InvestorRelationsEvent, type Stock } from '@prisma/client';
import { BoundedTaskQueue } from '../common/bounded-task-queue';
import { ProviderFactoryService } from '../analysis/provider-factory.service';
import { resolveEnvProviderName } from '../analysis/provider-resolver.service';
import { PrismaService } from '../prisma/prisma.service';
import type { PreparedInvestorRelationsSource } from './investor-relations-source.service';

const INVESTOR_RELATIONS_EXTRACTION_TIMEOUT_MS = 120_000;

@Injectable()
export class InvestorRelationsRunnerService implements OnModuleInit {
  private readonly logger = new Logger(InvestorRelationsRunnerService.name);
  private readonly queue = new BoundedTaskQueue<string>({
    concurrency: 2,
    execute: (runId) => this.run(runId),
  });

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly providerFactory: ProviderFactoryService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.prisma.investorRelationsGenerationRun.updateMany({
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
    const queued = await this.prisma.investorRelationsGenerationRun.findMany({
      where: { status: 'QUEUED' },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    queued.forEach(({ id }) => this.schedule(id));
  }

  schedule(runId: string): void {
    this.queue.schedule(runId);
  }

  async run(runId: string): Promise<void> {
    const claimed = await this.prisma.investorRelationsGenerationRun.updateMany({
      where: { id: runId, status: 'QUEUED' },
      data: { status: 'RUNNING', stage: 'EXTRACT', startedAt: new Date() },
    });
    if (claimed.count === 0) return;
    try {
      const run = await this.prisma.investorRelationsGenerationRun.findUnique({
        where: { id: runId },
        include: { stock: true },
      });
      if (!run) return;
      const source = parseSourceDescriptor(run.sourceDescriptor);
      const [filing, derivation] = await Promise.all([
        this.prisma.filing.findUnique({ where: { id: source.filingId } }),
        this.prisma.filingDerivation.findUnique({ where: { id: source.derivationId } }),
      ]);
      if (!filing || !derivation) throw new IrRunError('SOURCE_NOT_PERSISTED', false);
      const provider = this.providerFactory.buildProvider(resolveEnvProviderName(this.config));
      const model = provider.getUtilityModel();
      const prompt = buildInvestorRelationsUserPrompt({
        title: filing.title ?? undefined,
        sourceUrl: filing.sourceUrl,
        publishedAt: filing.publishedAt.toISOString(),
        normalizedText: derivation.normalizedText,
        pages: parsePages(derivation.pages),
      });
      const extractionKey = computeContentHash({
        text: JSON.stringify({ filingId: filing.id, derivationId: derivation.id, model, promptVersion: INVESTOR_RELATIONS_PROMPT_VERSION }),
      });
      const cached = await this.prisma.filingDerivation.findUnique({ where: { derivationKey: extractionKey } });
      let extraction;
      if (cached?.extraction) {
        extraction = InvestorRelationsExtractionSchema.parse(cached.extraction);
      } else {
        const result = await structuredOutputWithRepair(
          provider,
          INVESTOR_RELATIONS_SYSTEM_PROMPT,
          prompt,
          InvestorRelationsExtractionSchema,
          { maxTokens: INVESTOR_RELATIONS_MAX_OUTPUT_TOKENS, signal: AbortSignal.timeout(INVESTOR_RELATIONS_EXTRACTION_TIMEOUT_MS) },
        );
        extraction = result.data;
        await this.prisma.filingDerivation.create({
          data: {
            filingId: filing.id,
            derivationKey: extractionKey,
            status: 'COMPLETE',
            normalizedText: derivation.normalizedText,
            contentHash: derivation.contentHash,
            pages: derivation.pages ?? undefined,
            sections: derivation.sections ?? undefined,
            extraction: extraction as unknown as Prisma.InputJsonValue,
          },
        });
      }
      await this.prisma.investorRelationsGenerationRun.update({ where: { id: runId }, data: { stage: 'CHECK' } });
      validateActivityDate(extraction.occurredAt, filing.publishedAt);
      const pages = parsePages(derivation.pages);
      const extractedTopics = extraction.topics ?? [];
      const extractedClaims = extraction.managementClaims ?? [];
      const companyParticipants = (extraction.companyParticipants ?? []).flatMap((participant) =>
        participant.role ? [{ name: participant.name, role: participant.role }] : [],
      );
      const topics = extractedTopics.flatMap((candidate, index) => {
        const span = groundedSpan(derivation.normalizedText, pages, candidate.sourceQuote, candidate.sourcePage, candidate.sourceSection);
        const title = candidate.title ?? topicTitle(candidate.text);
        return span ? [{ id: computeContentHash({ text: `${filing.id}:topic:${span.startOffset}:${title}` }), title, text: candidate.text, sourceSpan: { ...span, kind: 'filingSpan' as const, filingId: filing.id, derivationId: derivation.id, contentHash: derivation.contentHash }, order: index }] : [];
      }).map(({ order: _order, ...item }) => item);
      const managementClaims = extractedClaims.flatMap((candidate, index) => {
        const span = groundedSpan(derivation.normalizedText, pages, candidate.sourceQuote, candidate.sourcePage, candidate.sourceSection);
        return span ? [{ id: computeContentHash({ text: `${filing.id}:claim:${span.startOffset}:${candidate.text}` }), text: candidate.text, sourceSpan: { ...span, kind: 'filingSpan' as const, filingId: filing.id, derivationId: derivation.id, contentHash: derivation.contentHash }, order: index }] : [];
      }).map(({ order: _order, ...item }) => item);
      if (topics.length === 0 && managementClaims.length === 0) throw new IrRunError('CHECK_REJECTED_ALL', true);
      const { event, relationType } = await this.ensureEvent(run.stock, filing, extraction.occurredAt, extraction.activityType);
      await this.prisma.investorRelationsGenerationRun.update({ where: { id: runId }, data: { eventId: event.id, stage: 'PERSIST' } });
      await this.prisma.investorRelationsEventFiling.upsert({
        where: { eventId_filingId: { eventId: event.id, filingId: filing.id } },
        update: { relationType },
        create: { eventId: event.id, filingId: filing.id, relationType },
      });
      const payload = InvestorRelationsRevisionPayloadSchema.parse({
        schemaVersion: INVESTOR_RELATIONS_SCHEMA_VERSION,
        event: {
          instrumentId: `CN:${run.stock.symbol}`,
          occurredAt: extraction.occurredAt,
          activityType: extraction.activityType,
          companyParticipants,
          institutions: extraction.institutions,
        },
        filing: filingDescriptor(filing, relationType),
        supportingFilings: [],
        topics,
        managementClaims,
        omittedItemCount: extractedTopics.length + extractedClaims.length - topics.length - managementClaims.length,
        generatedAt: new Date().toISOString(),
      });
      const revision = await this.persistRevision(event, payload, relationType);
      await this.prisma.investorRelationsGenerationRun.update({
        where: { id: runId },
        data: { revisionId: revision.id, status: 'COMPLETED', stage: 'DONE', retryable: false, completedAt: new Date() },
      });
    } catch (error) {
      const failure = error instanceof IrRunError ? error : new IrRunError('IR_GENERATION_FAILED', true, error instanceof Error ? error.message : String(error));
      await this.prisma.investorRelationsGenerationRun.update({
        where: { id: runId },
        data: { status: 'FAILED', retryable: failure.retryable, errorCode: failure.code, errorMessage: failure.message, completedAt: new Date() },
      }).catch((persistError) => this.logger.error(`failed to persist IR run error: ${String(persistError)}`));
    }
  }

  private async ensureEvent(stock: Stock, filing: Filing, occurredAt: string, activityType: InvestorRelationsEvent['activityType']) {
    const start = new Date(`${occurredAt}T00:00:00.000Z`);
    const end = new Date(start.getTime() + 86_400_000);
    const correction = /更正|修正/.test(filing.title ?? '');
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`ir-event:${stock.id}:${occurredAt}`}))`;
      const existing = await tx.investorRelationsEvent.findMany({
        where: { stockId: stock.id, occurredAt: { gte: start, lt: end } },
        orderBy: { createdAt: 'asc' },
        include: { filingLinks: { include: { filing: true } } },
      });
      if (correction && existing.length > 0) {
        return { event: existing.find((candidate) => candidate.activityType === activityType) ?? existing[0], relationType: 'CORRECTS' as const };
      }
      const duplicate = existing.find((candidate) =>
        candidate.activityType === activityType
        && candidate.filingLinks.some(({ filing: linked }) =>
          linked.contentHash === filing.contentHash
          || Boolean(filing.sourceGroupId && linked.sourceGroupId === filing.sourceGroupId)),
      );
      if (duplicate) return { event: duplicate, relationType: 'SUPPLEMENTS' as const };
      const event = await tx.investorRelationsEvent.create({
        data: { stockId: stock.id, title: filing.title ?? '投资者关系活动记录', activityType, occurredAt: start, publishedAt: filing.publishedAt },
      });
      return { event, relationType: 'PRIMARY' as const };
    });
  }

  private async persistRevision(
    event: InvestorRelationsEvent,
    payload: InvestorRelationsRevisionPayload,
    relationType: 'PRIMARY' | 'SUPPLEMENTS' | 'CORRECTS',
  ) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`ir:${event.id}`}))`;
      const lockedEvent = await tx.investorRelationsEvent.findUniqueOrThrow({
        where: { id: event.id },
        select: { currentRevisionId: true },
      });
      const current = lockedEvent.currentRevisionId
        ? await tx.investorRelationsRevision.findUnique({ where: { id: lockedEvent.currentRevisionId } })
        : null;
      const currentPayload = current ? InvestorRelationsRevisionPayloadSchema.safeParse(current.payload) : null;
      const mergedPayload = relationType === 'SUPPLEMENTS' && currentPayload?.success
        ? mergeSupportingSource(currentPayload.data, payload.filing)
        : payload;
      const { generatedAt: _generatedAt, ...stablePayload } = mergedPayload;
      const contentHash = computeContentHash({ text: JSON.stringify(stablePayload) });
      if (current?.contentHash === contentHash) return current;
      const latest = await tx.investorRelationsRevision.findFirst({ where: { eventId: event.id }, orderBy: { revisionNo: 'desc' }, select: { revisionNo: true } });
      const revision = await tx.investorRelationsRevision.create({
        data: { eventId: event.id, revisionNo: (latest?.revisionNo ?? 0) + 1, status: mergedPayload.managementClaims.length && mergedPayload.topics.length ? 'COMPLETE' : 'PARTIAL', payload: mergedPayload as unknown as Prisma.InputJsonValue, contentHash },
      });
      if (lockedEvent.currentRevisionId) {
        await tx.investorRelationsRevision.update({
          where: { id: lockedEvent.currentRevisionId },
          data: { supersededAt: new Date() },
        });
      }
      await tx.investorRelationsEvent.update({ where: { id: event.id }, data: { currentRevisionId: revision.id } });
      return revision;
    });
  }
}

function parseSourceDescriptor(value: Prisma.JsonValue): PreparedInvestorRelationsSource {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new IrRunError('INVALID_SOURCE_DESCRIPTOR', false);
  const source = value as Record<string, unknown>;
  for (const key of ['filingId', 'derivationId', 'provider', 'sourceDocumentId', 'sourceUrl', 'publishedAt']) {
    if (typeof source[key] !== 'string' || !source[key]) throw new IrRunError('INVALID_SOURCE_DESCRIPTOR', false);
  }
  return source as unknown as PreparedInvestorRelationsSource;
}

function groundedSpan(text: string, pages: FilingPage[] | undefined, quote: string, page: number | undefined, section: string | undefined) {
  if (pages?.length && page === undefined) return null;
  const span = locateSourceSpan(text, quote, page, pages);
  return span ? { quote: span.quote, startOffset: span.startOffset, endOffset: span.endOffset, page: span.page, section } : null;
}

function parsePages(value: Prisma.JsonValue | null): FilingPage[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const page = item as Record<string, unknown>;
    return typeof page.page === 'number' && typeof page.startOffset === 'number' && typeof page.endOffset === 'number'
      ? [{ page: page.page, text: typeof page.text === 'string' ? page.text : '', startOffset: page.startOffset, endOffset: page.endOffset }]
      : [];
  });
}

function filingDescriptor(filing: Filing, relationType: 'PRIMARY' | 'SUPPLEMENTS' | 'CORRECTS') {
  return { filingId: filing.id, formType: filing.formType, title: filing.title ?? undefined, sourceUrl: filing.sourceUrl, publishedAt: filing.publishedAt.toISOString(), provider: filing.provider, language: filing.language ?? undefined, relationType };
}

function mergeSupportingSource(
  current: InvestorRelationsRevisionPayload,
  supporting: InvestorRelationsRevisionPayload['filing'],
): InvestorRelationsRevisionPayload {
  const supportingFilings = [...current.supportingFilings];
  if (supporting.filingId !== current.filing.filingId && !supportingFilings.some((source) => source.filingId === supporting.filingId)) {
    supportingFilings.push({ ...supporting, relationType: 'SUPPLEMENTS' });
  }
  return {
    ...current,
    supportingFilings,
    generatedAt: new Date().toISOString(),
  };
}

function topicTitle(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length > 32 ? `${normalized.slice(0, 31)}…` : normalized;
}

function validateActivityDate(occurredAt: string, publishedAt: Date): void {
  const date = new Date(`${occurredAt}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.getTime() > publishedAt.getTime() + 86_400_000) throw new IrRunError('ACTIVITY_DATE_UNRESOLVED', false);
}

class IrRunError extends Error {
  constructor(public readonly code: string, public readonly retryable: boolean, message?: string) {
    super(message ?? code);
  }
}
