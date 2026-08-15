import type { AnalysisDto, AnalysisHistoryItemDto } from '@/lib/api';
import type { AnalysisMode, FocusWindow } from '@bourse/shared-types';

export type CreatePayload = {
  mode: AnalysisMode;
  focusWindow: FocusWindow;
  settingId?: string;
  model?: string;
  question?: string;
};

export interface LifecycleState {
  recentAnalyses: AnalysisHistoryItemDto[];
  current: AnalysisHistoryItemDto | null;
  checkingOngoing: boolean;
  loading: boolean;
}

export const INITIAL_LIFECYCLE_STATE: LifecycleState = {
  recentAnalyses: [],
  current: null,
  checkingOngoing: true,
  loading: false,
};

export type LifecycleAction =
  | { t: 'checking'; v: boolean }
  | { t: 'loading'; v: boolean }
  | { t: 'recent'; items: AnalysisHistoryItemDto[] }
  | { t: 'current'; analysis: AnalysisHistoryItemDto | null };

export function lifecycleReducer(state: LifecycleState, action: LifecycleAction): LifecycleState {
  switch (action.t) {
    case 'checking': return { ...state, checkingOngoing: action.v };
    case 'loading': return { ...state, loading: action.v };
    case 'recent': return { ...state, recentAnalyses: action.items };
    case 'current': return { ...state, current: action.analysis };
  }
}

export function findOngoingAnalysis(items: AnalysisHistoryItemDto[]): AnalysisHistoryItemDto | undefined {
  return items.find((analysis) => analysis.status === 'IN_PROGRESS' || analysis.status === 'PENDING');
}

export function buildStockAnalysisUrl(input: {
  symbol: string | null;
  stockId: string;
  analysisId: string;
  market?: string;
  name?: string;
}): string {
  const params = new URLSearchParams({ stockId: input.stockId, analysisId: input.analysisId });
  if (input.market) params.set('market', input.market);
  if (input.name) params.set('name', input.name);
  return `/stock/${encodeURIComponent(input.symbol ?? '')}?${params.toString()}`;
}

export type AnalysisWithSections = AnalysisDto | AnalysisHistoryItemDto;
