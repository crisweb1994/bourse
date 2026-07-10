import type { AnalysisStatus, SectionType } from '@bourse/shared-types';

export interface AnalysisSsePayloadMap {
  evidence_pack_ready: {
    pack: unknown;
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
  citation: {
    title: string;
    url: string;
    claim: string;
    sectionType?: SectionType;
    searchAdapter?: string;
  };
  structured_data: {
    json: unknown;
    sectionType: SectionType;
  };
  web_search_warning: {
    sectionType?: SectionType;
    code: string;
    occurredAt: string;
    round?: number;
  };
  section_complete: {
    sectionType: SectionType;
    status: AnalysisStatus;
    error?: string | null;
  };
  judge_start: {
    sectionType: SectionType;
  };
  judge_complete: {
    sectionType: SectionType;
    result: unknown;
    traceTokensIn?: number;
    traceTokensOut?: number;
    traceCostUsd?: number;
    traceDurationMs?: number;
  };
  summary_chunk: {
    text: string;
  };
  summary_complete: {
    summaryJson: unknown;
  };
  done: {
    analysisId: string;
    status?: AnalysisStatus;
  };
  error: {
    message: string;
    failedSections?: SectionType[];
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
