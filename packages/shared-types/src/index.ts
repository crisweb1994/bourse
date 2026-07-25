export * from './chat';
export * from './build-metadata';
export * from './earnings';

// ===== Enums =====

function enumObject<const T extends readonly string[]>(
  values: T,
): { [K in T[number]]: K } {
  return Object.fromEntries(values.map((value) => [value, value])) as {
    [K in T[number]]: K;
  };
}

export const ANALYSIS_DIMENSIONS = [
  'FUNDAMENTAL',
  'GOVERNANCE',
  'VALUATION',
  'INDUSTRY',
  'RISK',
  'TECHNICAL',
  'SENTIMENT',
  'SCENARIO',
  'PORTFOLIO',
] as const;

export type AnalysisDimension = (typeof ANALYSIS_DIMENSIONS)[number];

export const SECTION_TYPES = ANALYSIS_DIMENSIONS;
export type SectionType = AnalysisDimension;

const SECTION_TYPE_SET = new Set<string>(SECTION_TYPES);

export function isSectionType(value: string): value is SectionType {
  return SECTION_TYPE_SET.has(value);
}

export const COMPREHENSIVE_DIMENSIONS = ANALYSIS_DIMENSIONS;

export const ACTIVE_ANALYSIS_TYPES = [
  ...ANALYSIS_DIMENSIONS,
  'COMPREHENSIVE',
] as const;

export type ActiveAnalysisType = (typeof ACTIVE_ANALYSIS_TYPES)[number];

const ACTIVE_ANALYSIS_TYPE_SET = new Set<string>(ACTIVE_ANALYSIS_TYPES);

export function isActiveAnalysisType(
  value: string,
): value is ActiveAnalysisType {
  return ACTIVE_ANALYSIS_TYPE_SET.has(value);
}

export const LEGACY_ANALYSIS_TYPES = ['DEBATE'] as const;
export type LegacyAnalysisType = (typeof LEGACY_ANALYSIS_TYPES)[number];

export const ALL_ANALYSIS_TYPES = [
  ...ACTIVE_ANALYSIS_TYPES,
  ...LEGACY_ANALYSIS_TYPES,
] as const;

export const AnalysisType = enumObject(ALL_ANALYSIS_TYPES);
export type AnalysisType = (typeof ALL_ANALYSIS_TYPES)[number];

const ANALYSIS_TYPE_SET = new Set<string>(ALL_ANALYSIS_TYPES);

export function isAnalysisType(value: string): value is AnalysisType {
  return ANALYSIS_TYPE_SET.has(value);
}

export const ANALYSIS_TYPE_LABELS: Record<AnalysisType, string> = {
  FUNDAMENTAL: '基本面',
  GOVERNANCE: '公司治理',
  VALUATION: '估值',
  INDUSTRY: '行业竞争',
  RISK: '风险',
  TECHNICAL: '技术面',
  SENTIMENT: '情绪',
  SCENARIO: '情景',
  PORTFOLIO: '组合适配',
  COMPREHENSIVE: '综合分析',
  DEBATE: 'AI 多空合议',
};

export const AnalysisStatus = {
  PENDING: 'PENDING',
  IN_PROGRESS: 'IN_PROGRESS',
  COMPLETED: 'COMPLETED',
  PARTIAL_FAILED: 'PARTIAL_FAILED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
  BUDGET_EXHAUSTED: 'BUDGET_EXHAUSTED',
} as const;

export type AnalysisStatus =
  (typeof AnalysisStatus)[keyof typeof AnalysisStatus];

const ANALYSIS_STATUS_SET = new Set<string>(Object.values(AnalysisStatus));

export function isAnalysisStatus(value: string): value is AnalysisStatus {
  return ANALYSIS_STATUS_SET.has(value);
}

export const TERMINAL_ANALYSIS_STATUSES = [
  AnalysisStatus.COMPLETED,
  AnalysisStatus.PARTIAL_FAILED,
  AnalysisStatus.FAILED,
  AnalysisStatus.CANCELLED,
  AnalysisStatus.BUDGET_EXHAUSTED,
] as const;

export type AnalysisTerminalStatus =
  (typeof TERMINAL_ANALYSIS_STATUSES)[number];

const TERMINAL_ANALYSIS_STATUS_SET = new Set<string>(
  TERMINAL_ANALYSIS_STATUSES,
);

export function isTerminalAnalysisStatus(
  status: string,
): status is AnalysisTerminalStatus {
  return TERMINAL_ANALYSIS_STATUS_SET.has(status);
}

export const Signal = {
  BULLISH: 'BULLISH',
  NEUTRAL: 'NEUTRAL',
  BEARISH: 'BEARISH',
} as const;

export type Signal = (typeof Signal)[keyof typeof Signal];

const SIGNAL_SET = new Set<string>(Object.values(Signal));

export function isSignal(value: string): value is Signal {
  return SIGNAL_SET.has(value);
}

export const Confidence = {
  HIGH: 'HIGH',
  MEDIUM: 'MEDIUM',
  LOW: 'LOW',
} as const;

export type Confidence = (typeof Confidence)[keyof typeof Confidence];

const CONFIDENCE_SET = new Set<string>(Object.values(Confidence));

export function isConfidence(value: string): value is Confidence {
  return CONFIDENCE_SET.has(value);
}

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
    type: SectionType;
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
  // Search can return markets outside the persisted Market enum; stock
  // creation resolves or rejects them at the API boundary.
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
