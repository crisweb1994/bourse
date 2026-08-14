'use client';

import type { AnalysisMode, Confidence, FocusWindow, OverallSignal, SectionType } from '@bourse/shared-types';
import type { OverallConclusionDto } from '@/lib/api';
import { SECTION_LABELS } from '@/lib/constants';

export const ANALYSIS_MODE_OPTIONS: Array<{ value: AnalysisMode; label: string }> = [
  { value: 'QUICK', label: '快速扫描' },
  { value: 'DEEP', label: '深度研究' },
];

export const FOCUS_WINDOW_OPTIONS: Array<{ value: FocusWindow; label: string }> = [
  { value: '30D', label: '最近 30 天' },
  { value: '90D', label: '最近 90 天' },
  { value: '1Y', label: '最近 1 年' },
  { value: '3Y', label: '最近 3 年' },
];

export function formatAnalysisTime(iso: string | null | undefined, locale = 'zh-CN', timeZone?: string): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString(locale, {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    hour12: false, ...(timeZone ? { timeZone } : {}),
  });
}

export function getRequestedAnalysisId(searchParams: Pick<URLSearchParams, 'get'>): string | null {
  return searchParams.get('analysisId');
}

export function inferMarketFromSymbol(symbol: string | null): string {
  const normalized = symbol?.trim().toUpperCase() ?? '';
  if (normalized.endsWith('.HK')) return 'HK';
  if (normalized.endsWith('.SS') || normalized.endsWith('.SZ')) return 'CN';
  return normalized ? 'US' : '';
}

export interface SectionLike {
  type: SectionType;
  status: string;
  structuredJson?: {
    assessment?: string;
    confidence?: Confidence;
    summary?: string;
  } | null;
}

export interface SummaryLike extends OverallConclusionDto {
  headline: string;
  signal: OverallSignal | null;
}

export function buildRightInsightsSummary(
  summaryJson: SummaryLike | null | undefined,
  sections: SectionLike[],
): SummaryLike | null {
  if (summaryJson) return summaryJson;
  const usable = sections.filter((section) => section.structuredJson?.assessment);
  if (usable.length === 0) return null;
  return {
    headline: '综合结论尚未生成',
    signal: null,
    confidence: 'LOW',
    rationale: [],
    counterpoints: [],
    changeConditions: [],
    missingSections: sections.filter((section) => !section.structuredJson).map((section) => section.type),
    dataAsOf: '',
  };
}

export function sectionTitle(type: SectionType): string {
  return SECTION_LABELS[type] ?? type;
}
