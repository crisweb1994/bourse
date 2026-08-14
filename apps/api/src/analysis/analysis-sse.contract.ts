import type { AnalysisStatus, SectionStatus, SectionType } from '@bourse/shared-types';

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
