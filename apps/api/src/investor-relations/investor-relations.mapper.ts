import { InvestorRelationsRevisionPayloadSchema } from '@bourse/analysis';
import type { InvestorRelationsEventDto, InvestorRelationsGenerationRunDto, InvestorRelationsSourceDto } from '@bourse/shared-types';
import type { InvestorRelationsEvent, InvestorRelationsGenerationRun, InvestorRelationsRevision, Stock } from '@prisma/client';

type RevisionWithEvent = InvestorRelationsRevision & { event: InvestorRelationsEvent & { stock: Stock } };

export function toInvestorRelationsEventDto(revision: RevisionWithEvent): InvestorRelationsEventDto {
  const payload = InvestorRelationsRevisionPayloadSchema.parse(revision.payload);
  const sourceByFiling = new Map([payload.filing, ...payload.supportingFilings].map((source) => [source.filingId, source]));
  const sourceFor = (span: { filingId: string; quote: string; page?: number; section?: string; startOffset: number; endOffset: number }): InvestorRelationsSourceDto => {
    const source = sourceByFiling.get(span.filingId) ?? payload.filing;
    return { filingId: source.filingId, title: source.title, sourceUrl: source.sourceUrl, provider: source.provider, publishedAt: source.publishedAt, quote: span.quote, page: span.page, section: span.section, startOffset: span.startOffset, endOffset: span.endOffset };
  };
  return {
    id: revision.eventId,
    revisionId: revision.id,
    revisionNo: revision.revisionNo,
    stockId: revision.event.stockId,
    symbol: revision.event.stock.symbol,
    name: revision.event.stock.name,
    market: 'CN',
    title: revision.event.title,
    activityType: payload.event.activityType,
    occurredAt: payload.event.occurredAt,
    publishedAt: revision.event.publishedAt.toISOString(),
    companyParticipants: payload.event.companyParticipants,
    institutions: payload.event.institutions,
    topics: payload.topics.map((topic) => ({ id: topic.id, title: topic.title, text: topic.text, source: sourceFor(topic.sourceSpan) })),
    managementClaims: payload.managementClaims.map((claim) => ({ id: claim.id, text: claim.text, source: sourceFor(claim.sourceSpan) })),
    filing: { filingId: payload.filing.filingId, title: payload.filing.title, sourceUrl: payload.filing.sourceUrl, provider: payload.filing.provider, publishedAt: payload.filing.publishedAt },
    omittedItemCount: payload.omittedItemCount,
    revisionStatus: revision.status,
    generatedAt: revision.generatedAt.toISOString(),
    supersededAt: revision.supersededAt?.toISOString(),
  };
}

export function toInvestorRelationsGenerationRunDto(
  run: InvestorRelationsGenerationRun & { revision?: RevisionWithEvent | null },
): InvestorRelationsGenerationRunDto {
  return {
    id: run.id,
    stockId: run.stockId,
    status: run.status,
    stage: run.stage,
    retryable: run.retryable,
    errorCode: run.errorCode ?? undefined,
    errorMessage: run.errorMessage ?? undefined,
    event: run.revision ? toInvestorRelationsEventDto(run.revision) : undefined,
    createdAt: run.createdAt.toISOString(),
    startedAt: run.startedAt?.toISOString(),
    completedAt: run.completedAt?.toISOString(),
  };
}
