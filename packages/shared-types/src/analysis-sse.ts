// Analysis SSE wire contract (KISS C3-1). Single source for the payload map
// shared by apps/api (analysis-sse.contract.ts re-exports) and apps/web
// (analysis-stream-state.ts re-exports). Event names, payloads, ordering,
// and replay behavior are public contracts — change all ends together.

import type { AnalysisStatus, SectionStatus, SectionType } from './index';

export interface AnalysisSsePayloadMap {
  evidence_pack_ready: {
    pack: {
      capturedAt: string | null;
      dataAsOf: unknown;
      degraded: boolean;
      missingFields: unknown[];
    };
  };
  section_skipped: {
    sectionType: SectionType;
    reason: string;
    missingFields: string[];
  };
  section_start: {
    sectionType: SectionType;
    sectionId: string;
    order: number;
  };
  report_chunk: {
    text: string;
    sectionType?: SectionType;
  };
  report_complete: {
    text: string;
    sectionType: SectionType;
  };
  citation: {
    title: string;
    url: string;
    claim: string;
    sectionType?: SectionType;
    searchAdapter?: string;
    sourceType?: string;
    retrievedAt?: string;
  };
  structured_data: {
    json: unknown;
    sectionType: SectionType;
  };
  section_complete: {
    sectionType: SectionType;
    status: SectionStatus;
    error?: string | null;
  };
  summary_chunk: {
    text: string;
  };
  summary_complete: {
    summaryJson: unknown;
  };
  cost_update: {
    /** Cumulative input + output tokens across the run so far. */
    totalTokens: number;
    /** Cumulative provider tool calls (e.g. web_search) across the run. */
    toolCalls: number;
  };
  done: {
    analysisId: string;
    status?: AnalysisStatus;
  };
  error: {
    message: string;
    failedSections?: SectionType[];
    sectionType?: SectionType;
  };
}

export type AnalysisSseEventName = keyof AnalysisSsePayloadMap;

export type AnalysisSseEvent = {
  [K in AnalysisSseEventName]: {
    event: K;
    data: AnalysisSsePayloadMap[K];
  };
}[AnalysisSseEventName];

export interface AnalysisSseCallback {
  <T extends AnalysisSseEventName>(
    event: T,
    data: AnalysisSsePayloadMap[T],
  ): void;
}

const ANALYSIS_SSE_EVENT_NAMES = [
  'evidence_pack_ready',
  'section_skipped',
  'section_start',
  'report_chunk',
  'report_complete',
  'citation',
  'structured_data',
  'section_complete',
  'summary_chunk',
  'summary_complete',
  'cost_update',
  'done',
  'error',
] as const satisfies readonly AnalysisSseEventName[];

const ANALYSIS_SSE_EVENT_NAME_SET = new Set<string>(ANALYSIS_SSE_EVENT_NAMES);

export function isAnalysisSseEventName(value: string): value is AnalysisSseEventName {
  return ANALYSIS_SSE_EVENT_NAME_SET.has(value);
}
