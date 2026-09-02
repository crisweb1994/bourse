export * from './chat';
export * from './build-metadata';
export * from './earnings';
export * from './charts';
export * from './screening';
export * from './homepage';
export * from './web-search-settings';
export * from './ai-provider-settings';

// ===== Enums =====

function enumObject<const T extends readonly string[]>(
  values: T,
): { [K in T[number]]: K } {
  return Object.fromEntries(values.map((value) => [value, value])) as {
    [K in T[number]]: K;
  };
}

export const SECTION_TYPES = [
  'COMPANY_QUALITY',
  'INDUSTRY_POSITION',
  'VALUATION_SCENARIOS',
  'RISK_REGISTER',
  'MARKET_SIGNALS',
] as const;

export type SectionType = (typeof SECTION_TYPES)[number];

const SECTION_TYPE_SET = new Set<string>(SECTION_TYPES);

export function isSectionType(value: string): value is SectionType {
  return SECTION_TYPE_SET.has(value);
}

export const SectionStatus = {
  PENDING: 'PENDING',
  IN_PROGRESS: 'IN_PROGRESS',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  SKIPPED: 'SKIPPED',
  CANCELLED: 'CANCELLED',
} as const;

export type SectionStatus =
  (typeof SectionStatus)[keyof typeof SectionStatus];

export const ANALYSIS_MODES = ['QUICK', 'DEEP'] as const;
export type AnalysisMode = (typeof ANALYSIS_MODES)[number];
export const AnalysisMode = enumObject(ANALYSIS_MODES);

export const FOCUS_WINDOWS = ['30D', '90D', '1Y', '3Y'] as const;
export type FocusWindow = (typeof FOCUS_WINDOWS)[number];
export const FocusWindow = enumObject(FOCUS_WINDOWS);

export const SECTION_LABELS: Record<SectionType, string> = {
  COMPANY_QUALITY: '公司质量',
  INDUSTRY_POSITION: '行业与竞争',
  VALUATION_SCENARIOS: '估值与情景',
  RISK_REGISTER: '风险清单',
  MARKET_SIGNALS: '市场信号',
};

export const SECTION_ORDER = SECTION_TYPES;

export const AnalysisStatus = {
  PENDING: 'PENDING',
  IN_PROGRESS: 'IN_PROGRESS',
  COMPLETED: 'COMPLETED',
  PARTIAL_FAILED: 'PARTIAL_FAILED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
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

export const OverallSignal = {
  POSITIVE: 'POSITIVE',
  NEUTRAL: 'NEUTRAL',
  CAUTIOUS: 'CAUTIOUS',
} as const;

export type OverallSignal = (typeof OverallSignal)[keyof typeof OverallSignal];

const OVERALL_SIGNAL_SET = new Set<string>(Object.values(OverallSignal));

export function isOverallSignal(value: string): value is OverallSignal {
  return OVERALL_SIGNAL_SET.has(value);
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

// Markets + Daily Brief enums (mirror Prisma enums; shared-types stays
// Prisma-free so apps/web can consume without @prisma/client).
export const Market = {
  US: 'US',
  CN: 'CN',
  HK: 'HK',
} as const;

export type Market = (typeof Market)[keyof typeof Market];

const MARKET_SET = new Set<string>(Object.values(Market));

/** Strict (case-sensitive) market guard; callers normalize before checking. */
export function isMarket(value: string): value is Market {
  return MARKET_SET.has(value);
}

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

// ===== API Types =====

export interface UserDto {
  id: string;
  githubId: string;
  email: string | null;
  name: string;
  avatarUrl: string | null;
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
