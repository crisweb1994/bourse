import type { EvidencePackAny } from '@bourse/analysis';

/** Versioned read-only boundary exposed by AnalysisModule to Chat. */
export interface AnalysisChatSummary {
  id: string;
  stockId: string;
  symbol: string;
  analysisType: string;
  status: string;
  generatedAt: string | null;
  dataAsOf: string | null;
  overallSignal: string | null;
  overallConfidence: string | null;
  degraded: boolean;
  hasEvidenceSnapshot: boolean;
}

export interface AnalysisChatContext extends AnalysisChatSummary {
  promptVersion: string | null;
  snapshot?: {
    id: string;
    schemaVersion: string;
    evidencePackVersion: string;
    capturedAt: string;
    dataAsOf: unknown;
    sourceMode: string;
    degraded: boolean;
    missingFields: string[];
    payload: EvidencePackAny | Record<string, unknown>;
    sourceSnapshots: unknown;
    contentHash: string;
    metadata?: {
      provider?: string | null;
      model?: string | null;
      promptVersion?: string | null;
    };
  };
  sections: Array<{
    id: string;
    type: string;
    status: string;
    reportMarkdown: string | null;
    structuredJson: unknown;
    citations: unknown;
  }>;
}

export interface AnalysisChatPort {
  getAnalysisContext(input: {
    userId: string;
    stockId: string;
    analysisId: string;
    sectionTypes?: string[];
  }): Promise<AnalysisChatContext>;
  listEligibleAnalyses(input: {
    userId: string;
    stockId: string;
  }): Promise<AnalysisChatSummary[]>;
}

export interface ChatSourceSnapshot {
  title: string;
  url: string;
  publisher?: string;
  publishedAt?: string;
  accessedAt: string;
  snippet?: string;
  contentHash?: string;
}

export interface ResearchGatewayResult {
  gatewayVersion: string;
  dataAsOf: string;
  sources: ChatSourceSnapshot[];
  citationCandidates: Array<{
    id: string;
    sourceIndex: number;
    claim?: string;
  }>;
}

export interface ResearchGatewayPort {
  research(input: {
    userId: string;
    stockId: string;
    symbol: string;
    question: string;
    requestId: string;
  }): Promise<ResearchGatewayResult>;
}

export const ANALYSIS_CHAT_PORT = Symbol('ANALYSIS_CHAT_PORT');
export const RESEARCH_GATEWAY_PORT = Symbol('RESEARCH_GATEWAY_PORT');
