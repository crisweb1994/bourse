import type {
  AnalysisMode,
  AnalysisStatus,
  Confidence,
  FocusWindow,
  OverallSignal,
  StockDto,
} from './index';

export interface HomepageLatestResearchDto {
  analysisId: string;
  signal: OverallSignal | null;
  confidence: Confidence | null;
  dataAsOf: string | null;
}

export interface HomepageWatchlistItemDto {
  id: string;
  stock: StockDto;
  latestResearch: HomepageLatestResearchDto | null;
}

export type HomepageChangeKind = 'FILING' | 'EARNINGS_CARD';

export interface HomepageChangeDto {
  id: string;
  kind: HomepageChangeKind;
  stock: StockDto;
  title: string;
  detail: string;
  occurredAt: string;
}

export interface HomepageRecentAnalysisDto {
  id: string;
  stock: StockDto;
  mode: AnalysisMode;
  focusWindow: FocusWindow;
  status: AnalysisStatus;
  createdAt: string;
}

export interface HomepageBriefDto {
  watchlist: HomepageWatchlistItemDto[];
  hasMoreWatchlist: boolean;
  changes: HomepageChangeDto[];
  recentAnalyses: HomepageRecentAnalysisDto[];
}
