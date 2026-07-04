// ===== Enums =====

export const AnalysisType = {
  FUNDAMENTAL: 'FUNDAMENTAL',
  VALUATION: 'VALUATION',
  INDUSTRY: 'INDUSTRY',
  RISK: 'RISK',
  TECHNICAL: 'TECHNICAL',
  SENTIMENT: 'SENTIMENT',
  SCENARIO: 'SCENARIO',
  PORTFOLIO: 'PORTFOLIO',
  GOVERNANCE: 'GOVERNANCE',
  COMPREHENSIVE: 'COMPREHENSIVE',
  DEBATE: 'DEBATE',
} as const;

export type AnalysisType = (typeof AnalysisType)[keyof typeof AnalysisType];

export const AnalysisStatus = {
  PENDING: 'PENDING',
  IN_PROGRESS: 'IN_PROGRESS',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
} as const;

export type AnalysisStatus =
  (typeof AnalysisStatus)[keyof typeof AnalysisStatus];

export const Signal = {
  BULLISH: 'BULLISH',
  NEUTRAL: 'NEUTRAL',
  BEARISH: 'BEARISH',
} as const;

export type Signal = (typeof Signal)[keyof typeof Signal];

export const Confidence = {
  HIGH: 'HIGH',
  MEDIUM: 'MEDIUM',
  LOW: 'LOW',
} as const;

export type Confidence = (typeof Confidence)[keyof typeof Confidence];

export const RiskTolerance = {
  CONSERVATIVE: 'CONSERVATIVE',
  MODERATE: 'MODERATE',
  AGGRESSIVE: 'AGGRESSIVE',
} as const;

export type RiskTolerance =
  (typeof RiskTolerance)[keyof typeof RiskTolerance];

export const InvestmentHorizon = {
  SHORT_TERM: 'SHORT_TERM',
  MEDIUM_TERM: 'MEDIUM_TERM',
  LONG_TERM: 'LONG_TERM',
} as const;

export type InvestmentHorizon =
  (typeof InvestmentHorizon)[keyof typeof InvestmentHorizon];

export const PreferredStyle = {
  VALUE: 'VALUE',
  GROWTH: 'GROWTH',
  DIVIDEND: 'DIVIDEND',
  MOMENTUM: 'MOMENTUM',
  BALANCED: 'BALANCED',
} as const;

export type PreferredStyle =
  (typeof PreferredStyle)[keyof typeof PreferredStyle];

// Markets + Daily Brief enums (mirror Prisma enums; shared-types stays
// Prisma-free so apps/web can consume without @prisma/client).
export const Market = {
  US: 'US',
  CN: 'CN',
  HK: 'HK',
} as const;

export type Market = (typeof Market)[keyof typeof Market];

export const DigestSession = {
  PRE: 'PRE',
  POST: 'POST',
} as const;

export type DigestSession =
  (typeof DigestSession)[keyof typeof DigestSession];

export const DeliveryStatus = {
  SENT: 'SENT',
  FAILED: 'FAILED',
  RETRYING: 'RETRYING',
} as const;

export type DeliveryStatus =
  (typeof DeliveryStatus)[keyof typeof DeliveryStatus];

export const ChannelType = {
  WEBHOOK: 'WEBHOOK',
  FEISHU: 'FEISHU',
  DINGTALK: 'DINGTALK',
  WECOM: 'WECOM',
  TELEGRAM: 'TELEGRAM',
  SLACK: 'SLACK',
} as const;

export type ChannelType = (typeof ChannelType)[keyof typeof ChannelType];

// ===== Structured JSON Types =====

export type CitationQualityTier = 'A' | 'B' | 'C' | 'D' | 'E';

export interface Citation {
  title: string;
  url: string;
  sourceType: 'NEWS' | 'FILING' | 'RESEARCH' | 'DATA_PROVIDER' | 'SOCIAL' | 'OTHER';
  retrievedAt: string;
  qualityTier?: CitationQualityTier;
}

export interface Evidence {
  claim: string;
  citations: Citation[];
}

export interface DataAvailability {
  missingFields: string[];
  reason: string;
}

export interface SectionConclusion {
  signal: Signal;
  confidence: Confidence;
  oneLiner: string;
  evidence: Evidence[];
}

// ===== Section-specific types (Phase 3) =====
// Defined here as stubs; full implementation in Phase 3

export interface BaseSectionData {
  conclusion: SectionConclusion;
  evidence: Evidence[];
  dataAvailability: DataAvailability;
  dataAsOf: string;
  disclaimer: string;
}

// ===== Comprehensive Summary =====

export interface ComprehensiveSummary {
  overallSignal: Signal;
  overallConfidence: Confidence;
  oneLiner: string;
  bullCase: string[];
  bearCase: string[];
  biggestRisk: string;
  valuationConclusion: string;
  suitableInvestorType: string;
  watchlistWorthy: boolean;
  sectionSignals: Array<{
    type: AnalysisType;
    signal: Signal;
    confidence: Confidence;
    oneLiner: string;
  }>;
  evidence: Evidence[];
  dataAsOf: string;
  disclaimer: string;
}

// ===== API Types =====

export interface UserDto {
  id: string;
  githubId: string;
  email: string | null;
  name: string;
  avatarUrl: string | null;
  /** RFC rfc-evidence-pack-web-search-fallback: per-user opt-in. */
  allowWebSearchFallback?: boolean;
}

export interface InvestorProfileDto {
  riskTolerance: RiskTolerance;
  investmentHorizon: InvestmentHorizon;
  preferredStyle: PreferredStyle;
  holdingsSummary?: string | null;
  maxDrawdown?: number | null;
  targetReturn?: number | null;
}

export interface StockDto {
  id: string;
  symbol: string;
  name: string;
  market: Market;
  exchange: string;
  currency: string;
  yahooSymbol: string | null;
}

export interface StockSearchResult {
  symbol: string;
  name: string;
  // 搜索可能返回 JP/UK 等 Phase-1.4 暂不支持的市场（resolveMarket 兜底 exchange），
  // 故保持 string；落库时由 StockDto.market(Market) 把关。
  market: string;
  exchange: string;
  currency: string;
  yahooSymbol?: string;
}

export interface WatchlistItemDto {
  id: string;
  userId: string;
  stockId: string;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  stock: StockDto;
}

// ===== SSE Event Types =====

export interface SseEvent {
  type:
    | 'section_start'
    | 'report_chunk'
    | 'report_complete'
    | 'structured_data'
    | 'citation'
    | 'section_complete'
    | 'summary_chunk'
    | 'summary_complete'
    | 'done'
    | 'error';
  data: unknown;
}

// plan-v2 Wave 3.2 — AnalysisResearchMode / AnalysisResearchSummaryDto and the
// research SSE event union (research_plan_ready / research_job_started /
// research_slot_update / research_snapshot_ready / confidence_cap_applied /
// research_fallback / ResearchEvidencePackReadyEvent) removed. The actual
// `evidence_pack_ready` SSE event is now defined as a zod schema in
// packages/analysis/src/contracts/sse-events.ts (EvidencePackReadyEvent).
