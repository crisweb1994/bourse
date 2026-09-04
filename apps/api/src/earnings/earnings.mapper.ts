import {
  EarningsCardPayloadSchema,
  type EarningsCardPayload,
  type MetricFact,
} from '@bourse/analysis';
import type {
  EarningsCardDto,
  EarningsGenerationRunDto,
  EarningsMetricFactDto,
  EarningsReconcileStatus,
} from '@bourse/shared-types';

interface RevisionWithCard {
  id: string;
  revisionNo: number;
  status: string;
  payload: unknown;
  generatedAt: Date;
  supersededAt: Date | null;
  event: {
    id: string;
    stockId: string;
    stock: { symbol: string; name: string; market: string };
  };
}

export function toEarningsCardDto(revision: RevisionWithCard): EarningsCardDto {
  const payload = EarningsCardPayloadSchema.parse(revision.payload);
  return {
    id: revision.event.id,
    revisionId: revision.id,
    revisionNo: revision.revisionNo,
    stockId: revision.event.stockId,
    instrumentId: payload.event.instrumentId,
    symbol: revision.event.stock.symbol,
    name: revision.event.stock.name,
    market: revision.event.stock.market as EarningsCardDto['market'],
    periodEndOn: payload.event.periodEndOn,
    periodType: payload.event.periodType,
    fiscalYear: payload.event.fiscalYear,
    fiscalQuarter: payload.event.fiscalQuarter,
    reportingScope: payload.event.reportingScope,
    filing: {
      filingId: payload.filing.filingId,
      formType: payload.filing.formType,
      title: payload.filing.title,
      sourceUrl: payload.filing.sourceUrl,
      provider: payload.filing.provider,
      language: payload.filing.language,
      publishedAt: payload.filing.publishedAt,
      unaudited: payload.filing.unaudited,
    },
    supportingFilings: payload.supportingFilings.map((filing) => ({
      filingId: filing.filingId,
      formType: filing.formType,
      title: filing.title,
      sourceUrl: filing.sourceUrl,
      provider: filing.provider,
      language: filing.language,
      publishedAt: filing.publishedAt,
      unaudited: filing.unaudited,
      relationType: filing.relationType,
    })),
    revisionStatus: revision.status as EarningsCardDto['revisionStatus'],
    facts: payload.facts.map((fact) => factToDto(fact, payload)),
    managementClaims: payload.managementClaims.map((claim) => {
      const source = sourceForFiling(payload, claim.sourceSpan.filingId);
      return {
        id: claim.id,
        text: claim.text,
        source: {
          kind: 'filingSpan' as const,
          sourceUrl: source.sourceUrl,
          provider: source.provider,
          quote: claim.sourceSpan.quote,
          page: claim.sourceSpan.page,
          section: claim.sourceSpan.section,
          startOffset: claim.sourceSpan.startOffset,
          endOffset: claim.sourceSpan.endOffset,
        },
      };
    }),
    dataStatus: payload.dataStatus,
    supplementalNonGaap: payload.supplementalNonGaap.map((item) => {
      const source = sourceForFiling(payload, item.sourceSpan.filingId);
      return {
        metricLabel: item.metricLabel,
        value: item.value,
        unit: item.unit,
        currency: item.currency,
        targetPeriodEndOn: item.targetPeriodEndOn,
        reconciliationContext: item.reconciliationContext,
        source: {
          kind: 'filingSpan' as const,
          sourceUrl: source.sourceUrl,
          provider: source.provider,
          quote: item.sourceSpan.quote,
          page: item.sourceSpan.page,
          section: item.sourceSpan.section,
          startOffset: item.sourceSpan.startOffset,
          endOffset: item.sourceSpan.endOffset,
        },
      };
    }),
    omittedFactCount: payload.omittedFactCount,
    statusSummary: payload.statusSummary,
    generatedAt: revision.generatedAt.toISOString(),
    supersededAt: revision.supersededAt?.toISOString(),
  };
}

export function toGenerationRunDto(
  run: {
    id: string;
    stockId: string;
    status: string;
    stage: string;
    retryable: boolean;
    errorCode: string | null;
    errorMessage: string | null;
    createdAt: Date;
    startedAt: Date | null;
    completedAt: Date | null;
    cardRevision?: RevisionWithCard | null;
  },
): EarningsGenerationRunDto {
  return {
    id: run.id,
    stockId: run.stockId,
    status: run.status as EarningsGenerationRunDto['status'],
    stage: run.stage,
    retryable: run.retryable,
    errorCode: run.errorCode ?? undefined,
    errorMessage: run.errorMessage ?? undefined,
    card: run.cardRevision ? toEarningsCardDto(run.cardRevision) : undefined,
    createdAt: run.createdAt.toISOString(),
    startedAt: run.startedAt?.toISOString(),
    completedAt: run.completedAt?.toISOString(),
  };
}

function factToDto(
  fact: MetricFact,
  payload: EarningsCardPayload,
): EarningsMetricFactDto {
  const source = fact.provenance.kind === 'filingSpan'
    ? sourceForFiling(payload, fact.provenance.filingId)
    : payload.filing;
  const reconcileStatus: EarningsReconcileStatus =
    fact.reconcileStatus.status === 'reconciled'
      ? {
          status: 'reconciled',
          delta: fact.reconcileStatus.delta,
          provider: fact.reconcileStatus.comparedWith.provider,
        }
      : fact.reconcileStatus.status === 'conflicted'
        ? {
            status: 'conflicted',
            delta: fact.reconcileStatus.delta,
            provider: fact.reconcileStatus.comparedWith.provider,
            sourceValue: fact.reconcileStatus.sourceValue,
            structuredValue: fact.reconcileStatus.structuredValue,
          }
        : fact.reconcileStatus;

  const provenance: EarningsMetricFactDto['provenance'] =
    fact.provenance.kind === 'filingSpan'
      ? {
          kind: 'filingSpan',
          sourceUrl: source.sourceUrl,
          provider: source.provider,
          quote: fact.provenance.quote,
          page: fact.provenance.page,
          section: fact.provenance.section,
          startOffset: fact.provenance.startOffset,
          endOffset: fact.provenance.endOffset,
        }
      : {
          kind: 'structuredSource',
          sourceUrl: fact.provenance.sourceUrl,
          provider: fact.provenance.provider,
          fieldPath: fact.provenance.fieldPath,
          asOf: fact.provenance.asOf,
          sourceNature: fact.provenance.sourceNature,
          qualityTier: fact.provenance.qualityTier,
          snapshotId: fact.provenance.snapshotId,
          sourceRevisionId: fact.provenance.sourceRevisionId,
          sourceFiledAt: fact.provenance.sourceFiledAt,
          accessionNumber: fact.provenance.accessionNumber,
        };

  return {
    id: fact.id,
    metricCode: fact.metricCode,
    value: fact.value,
    normalizedValue: fact.normalizedValue,
    unit: fact.unit,
    currency: fact.currency,
    scale: fact.scale,
    periodStartOn: fact.periodStartOn,
    periodEndOn: fact.periodEndOn,
    periodKind: fact.periodKind,
    accumulation: fact.accumulation,
    accountingBasis: fact.accountingBasis,
    consolidationScope: fact.consolidationScope,
    checkStatus: fact.provenance.kind === 'structuredSource' ? 'structured_only' : 'passed',
    derivation: fact.derivation,
    reconcileStatus,
    reconciliationOverdue: fact.reconcileStatus.status === 'pending'
      && Date.now() - new Date(source.publishedAt).getTime() > 45 * 24 * 60 * 60_000,
    comparisons: fact.comparisons.map((comparison) => ({
      kind: comparison.kind,
      label: comparison.label,
      referenceValue: comparison.referenceValue,
      absoluteDelta: comparison.absoluteDelta,
      percentDelta: comparison.percentDelta,
      outcome: comparison.outcome,
      asOf: comparison.asOf,
      provider: comparison.provider,
      sourceUrl: comparison.sourceUrl,
      sourceQuote: comparison.sourceSpan?.quote,
    })),
    provenance,
  };
}

function sourceForFiling(payload: EarningsCardPayload, filingId: string) {
  return [payload.filing, ...payload.supportingFilings].find((filing) => filing.filingId === filingId)
    ?? payload.filing;
}
