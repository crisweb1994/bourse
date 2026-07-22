export type EarningsGenerationStatus =
  | 'QUEUED'
  | 'RUNNING'
  | 'COMPLETED'
  | 'FAILED'
  | 'BUDGET_EXHAUSTED';

export type EarningsReconcileStatus =
  | { status: 'pending' }
  | { status: 'reconciled'; delta: string; provider: string }
  | {
      status: 'conflicted';
      delta: string;
      provider: string;
      sourceValue: EarningsMetricValueDto;
      structuredValue: EarningsMetricValueDto;
    }
  | { status: 'not_applicable'; reason: string };

export type EarningsMetricValueDto =
  | { kind: 'scalar'; value: string }
  | { kind: 'range'; min: string; max: string };

export interface EarningsComparisonDto {
  kind: 'YOY' | 'QOQ' | 'GUIDANCE' | 'CONSENSUS' | 'PREVIOUS_VERSION';
  label: string;
  referenceValue?: EarningsMetricValueDto;
  absoluteDelta?: string;
  percentDelta?: string;
  outcome?: 'within' | 'above' | 'below';
  asOf?: string;
  provider?: string;
  sourceUrl?: string;
  sourceQuote?: string;
}

export type EarningsProvenanceDto =
  | {
      kind: 'filingSpan';
      sourceUrl: string;
      provider: string;
      quote: string;
      page?: number;
      section?: string;
      startOffset: number;
      endOffset: number;
    }
  | {
      kind: 'structuredSource';
      sourceUrl: string;
      provider: string;
      fieldPath: string;
      asOf: string;
    };

export interface EarningsMetricFactDto {
  id: string;
  metricCode: string;
  value: EarningsMetricValueDto;
  normalizedValue?: EarningsMetricValueDto;
  unit: 'currency' | 'percent' | 'percentage_point' | 'shares' | 'per_share' | 'ratio';
  currency?: string;
  scale: number;
  periodStartOn?: string;
  periodEndOn: string;
  periodKind: 'instant' | 'duration';
  accumulation: 'discrete' | 'YTD' | 'FY';
  accountingBasis: string;
  consolidationScope: 'consolidated' | 'parent' | 'unknown';
  checkStatus: 'passed' | 'structured_only';
  reconcileStatus: EarningsReconcileStatus;
  reconciliationOverdue?: boolean;
  comparisons: EarningsComparisonDto[];
  provenance: EarningsProvenanceDto;
}

export interface EarningsManagementClaimDto {
  id: string;
  text: string;
  source: Extract<EarningsProvenanceDto, { kind: 'filingSpan' }>;
}

export interface EarningsCardDto {
  id: string;
  revisionId: string;
  revisionNo: number;
  stockId: string;
  instrumentId: string;
  symbol: string;
  name: string;
  market: 'US' | 'CN' | 'HK';
  periodEndOn: string;
  periodType: string;
  fiscalYear: number;
  fiscalQuarter?: number;
  reportingScope: 'consolidated' | 'parent' | 'unknown';
  filing: {
    filingId?: string;
    formType: string;
    title?: string;
    sourceUrl: string;
    provider: string;
    publishedAt: string;
    unaudited: boolean;
  };
  supportingFilings?: Array<{
    filingId?: string;
    formType: string;
    title?: string;
    sourceUrl: string;
    provider: string;
    publishedAt: string;
    unaudited: boolean;
    relationType?: 'SUPPLEMENTS' | 'CORRECTS' | 'SUPERSEDES';
  }>;
  revisionStatus: 'PARTIAL' | 'COMPLETE';
  facts: EarningsMetricFactDto[];
  managementClaims: EarningsManagementClaimDto[];
  omittedFactCount: number;
  statusSummary: {
    total: number;
    reconciled: number;
    pending: number;
    conflicted: number;
    structuredOnly: number;
  };
  generatedAt: string;
  supersededAt?: string;
}

export interface EarningsGenerationRunDto {
  id: string;
  stockId: string;
  status: EarningsGenerationStatus;
  stage: string;
  retryable: boolean;
  errorCode?: string;
  errorMessage?: string;
  card?: EarningsCardDto;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
}

export interface LatestEarningsResponseDto {
  available: boolean;
  supported: boolean;
  card?: EarningsCardDto;
  generation?: EarningsGenerationRunDto;
  reason?: string;
}
