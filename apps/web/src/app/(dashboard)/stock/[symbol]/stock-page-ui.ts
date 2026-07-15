import { ACTIVE_ANALYSIS_TYPES, ANALYSIS_TYPE_LABELS } from '@/lib/constants';
import type { Confidence, SectionType, Signal } from '@bourse/shared-types';

export const ANALYSIS_TYPES = ACTIVE_ANALYSIS_TYPES.map((value) => ({
  value,
  label: ANALYSIS_TYPE_LABELS[value],
}));

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

export interface SectionLike {
  type: SectionType;
  status: string;
  structuredJson?: {
    conclusion?: {
      signal?: Signal;
      confidence?: Confidence;
      oneLiner?: string;
    };
  } | null;
}

export interface SummaryLike {
  overallSignal: Signal;
  overallConfidence: Confidence;
  oneLiner?: string;
  sectionSignals?: Array<{
    type: SectionType;
    signal: Signal;
    confidence: Confidence;
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
