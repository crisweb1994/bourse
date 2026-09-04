import type { EvidencePackV2 } from '@bourse/analysis';

/** Versioned read-only boundary exposed by AnalysisModule to Chat. */
export interface AnalysisChatSummary {
  id: string;
  stockId: string;
  symbol: string;
  mode: string;
  focusWindow: string;
  status: string;
  createdAt: string;
  completedAt: string | null;
  dataAsOf: string | null;
  overallSignal: string | null;
  overallConfidence: string | null;
  degraded: boolean;
  hasEvidenceSnapshot: boolean;
}

export interface AnalysisChatContext extends AnalysisChatSummary {
  snapshot?: {
    id: string;
    capturedAt: string;
    dataAsOf: unknown;
    degraded: boolean;
    missingFields: string[];
    payload: EvidencePackV2 | Record<string, unknown>;
    sourceSnapshots: unknown;
  };
  sections: Array<{
    id: string;
    type: string;
    status: string;
    reportMarkdown: string | null;
    structuredJson: unknown;
    citations: Array<{
      title: string;
      url: string;
      claim: string;
    }>;
  }>;
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

