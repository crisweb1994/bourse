import {
  EarningsCardPayloadSchema,
  type EarningsCardPayload,
  type EarningsFilingDescriptor,
  type EarningsGuidanceStatus,
  type EarningsNarrativeStatus,
  type EarningsNumericStatus,
  type MetricFact,
  type StructuredEarningsSelection,
} from '@bourse/analysis';

/**
 * v2 卡片组装（docs/structured-first-earnings-architecture.md §13/§14）。
 *
 * 纯函数：selection 状态 → dataStatus.numeric；structured facts + narrative
 * claims + non-GAAP supplemental → 完整 EarningsCardPayload。不落库、不通知。
 */

export function numericStatusOf(
  selection: StructuredEarningsSelection,
): EarningsNumericStatus {
  switch (selection.status) {
    case 'ready':
      return 'ready';
    case 'pending':
      return 'pending_structured';
    case 'ambiguous':
      return 'ambiguous';
    case 'unsupported':
      return 'unsupported';
  }
}

export interface V2ManagementClaim {
  id: string;
  text: string;
  sourceSpan: EarningsCardPayload['managementClaims'][number]['sourceSpan'];
}

export interface V2SupplementalNonGaap {
  metricLabel: string;
  value: EarningsCardPayload['supplementalNonGaap'][number]['value'];
  unit: EarningsCardPayload['supplementalNonGaap'][number]['unit'];
  currency?: string;
  targetPeriodEndOn: string;
  reconciliationContext?: string;
  sourceSpan: EarningsCardPayload['supplementalNonGaap'][number]['sourceSpan'];
}

export interface BuildV2CardInput {
  schemaVersion: string;
  event: {
    instrumentId: string;
    periodEndOn: string;
    periodType: string;
    fiscalYear: number;
    reportingScope: EarningsCardPayload['event']['reportingScope'];
  };
  filing: EarningsFilingDescriptor;
  facts: MetricFact[];
  selection: StructuredEarningsSelection;
  managementClaims: V2ManagementClaim[];
  supplementalNonGaap: V2SupplementalNonGaap[];
  narrativeStatus: EarningsNarrativeStatus;
  guidanceStatus: EarningsGuidanceStatus;
  generatedAt: string;
}

export function buildV2CardPayload(input: BuildV2CardInput): EarningsCardPayload {
  return EarningsCardPayloadSchema.parse({
    schemaVersion: input.schemaVersion,
    event: input.event,
    filing: input.filing,
    supportingFilings: [],
    facts: input.facts,
    dataStatus: {
      numeric: numericStatusOf(input.selection),
      narrative: input.narrativeStatus,
      guidance: input.guidanceStatus,
    },
    supplementalNonGaap: input.supplementalNonGaap,
    managementClaims: input.managementClaims,
    omittedFactCount: 0,
    statusSummary: {
      total: input.facts.length,
      reconciled: 0,
      pending: 0,
      conflicted: 0,
      structuredOnly: input.facts.length,
    },
    generatedAt: input.generatedAt,
  });
}
