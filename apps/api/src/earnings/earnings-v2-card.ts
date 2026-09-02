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

/**
 * 构造 v2 卡片的 filing descriptor。
 *
 * Prisma 的 `language/title` 是 `string | null`，schema 只接受可选字符串；
 * 必须把 null 归一化为 undefined，否则卡片 payload 校验失败
 * （"Expected 'zh-CN' | ... , received null"）。
 */
export function buildV2FilingDescriptor(input: {
  filingId: string;
  formType: string;
  title: string | null;
  sourceUrl: string;
  publishedAt: string;
  provider: string;
  language: string | null;
  unaudited: boolean;
  relationType: EarningsCardPayload['filing']['relationType'];
}): EarningsFilingDescriptor {
  return {
    sourceKind: 'filing',
    filingId: input.filingId,
    formType: input.formType,
    title: input.title ?? undefined,
    sourceUrl: input.sourceUrl,
    publishedAt: input.publishedAt,
    provider: input.provider,
    language: (input.language as EarningsFilingDescriptor['language']) ?? undefined,
    unaudited: input.unaudited,
    relationType: input.relationType,
  };
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
    // KISS C5(E2-1):候选被选择器拒绝(字段完整性/期间/市场兼容检查)即不计入
    // facts,此处把拒绝数回填,让 web 的「N 项数字未通过检查未予展示」横幅可用。
    omittedFactCount: input.selection.diagnostics.rejected.length,
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
