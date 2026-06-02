export const ANALYSIS_TYPES = [
  { value: 'FUNDAMENTAL', label: '基本面' },
  { value: 'GOVERNANCE', label: '公司治理' },
  { value: 'VALUATION', label: '估值' },
  { value: 'INDUSTRY', label: '行业竞争' },
  { value: 'RISK', label: '风险' },
  { value: 'TECHNICAL', label: '技术面' },
  { value: 'SENTIMENT', label: '情绪' },
  { value: 'SCENARIO', label: '情景' },
  { value: 'PORTFOLIO', label: '组合适配' },
  { value: 'COMPREHENSIVE', label: '综合分析' },
] as const;

export function formatAnalysisTime(
  iso: string | null | undefined,
  locale = 'zh-CN',
  timeZone?: string,
): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(locale, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    ...(timeZone ? { timeZone } : {}),
  });
}

export function getRequestedAnalysisId(
  searchParams: Pick<URLSearchParams, 'get'>,
): string | null {
  return searchParams.get('analysisId') ?? searchParams.get('debateBase');
}

interface SectionLike {
  type: string;
  status: string;
  structuredJson?: {
    conclusion?: {
      signal?: string;
      confidence?: string;
      oneLiner?: string;
    };
  } | null;
}

interface SummaryLike {
  overallSignal: string;
  overallConfidence: string;
  oneLiner?: string;
  sectionSignals?: Array<{
    type: string;
    signal: string;
    confidence: string;
    oneLiner?: string;
  }>;
  biggestRisk?: string;
  watchlistWorthy?: boolean;
  dataAsOf?: string;
}

export function buildRightInsightsSummary(
  summaryJson: SummaryLike | null | undefined,
  sections: SectionLike[],
): SummaryLike | null {
  if (
    summaryJson &&
    ((summaryJson.sectionSignals?.length ?? 0) > 0 ||
      !!summaryJson.biggestRisk)
  ) {
    return summaryJson;
  }

  const sectionSignals = sections
    .map((section) => {
      const conclusion = section.structuredJson?.conclusion;
      if (!conclusion?.signal) return null;
      return {
        type: section.type,
        signal: conclusion.signal,
        confidence: conclusion.confidence ?? 'LOW',
        ...(conclusion.oneLiner ? { oneLiner: conclusion.oneLiner } : {}),
      };
    })
    .filter((item): item is NonNullable<typeof item> => item !== null);

  if (sectionSignals.length === 0) return null;

  return {
    overallSignal: 'NEUTRAL',
    overallConfidence: 'MEDIUM',
    sectionSignals,
  };
}

