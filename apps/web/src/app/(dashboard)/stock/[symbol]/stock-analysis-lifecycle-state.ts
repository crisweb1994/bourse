import type { AnalysisDto } from '@/lib/api';
import type { ActiveAnalysisType } from '@bourse/shared-types';

export type CreatePayload = {
  type: ActiveAnalysisType;
  settingId?: string;
  model?: string;
};

export interface LifecycleState {
  recentAnalyses: AnalysisDto[];
  current: AnalysisDto | null;
  checkingOngoing: boolean;
  loading: boolean;
  conflict: AnalysisDto | null;
  conflictPending: CreatePayload | null;
  autoSwitchedFrom: AnalysisDto | null;
}

export const INITIAL_LIFECYCLE_STATE: LifecycleState = {
  recentAnalyses: [],
  current: null,
  checkingOngoing: true,
  loading: false,
  conflict: null,
  conflictPending: null,
  autoSwitchedFrom: null,
};

export type LifecycleAction =
  | { t: 'checking'; v: boolean }
  | { t: 'loading'; v: boolean }
  | { t: 'recent'; items: AnalysisDto[] }
  | { t: 'current'; analysis: AnalysisDto | null }
  | { t: 'conflict'; analysis: AnalysisDto | null; pending: CreatePayload | null }
  | { t: 'clearConflict' }
  | { t: 'conflictPending'; pending: CreatePayload | null }
  | { t: 'autoSwitched'; analysis: AnalysisDto | null }
  | { t: 'markCancelled'; id: string };

export function lifecycleReducer(
  state: LifecycleState,
  action: LifecycleAction,
): LifecycleState {
  switch (action.t) {
    case 'checking':
      return { ...state, checkingOngoing: action.v };
    case 'loading':
      return { ...state, loading: action.v };
    case 'recent':
      return { ...state, recentAnalyses: action.items };
    case 'current':
      return { ...state, current: action.analysis };
    case 'conflict':
      return {
        ...state,
        conflict: action.analysis,
        conflictPending: action.pending,
      };
    case 'clearConflict':
      return { ...state, conflict: null, conflictPending: null };
    case 'conflictPending':
      return { ...state, conflictPending: action.pending };
    case 'autoSwitched':
      return { ...state, autoSwitchedFrom: action.analysis };
    case 'markCancelled':
      return {
        ...state,
        recentAnalyses: state.recentAnalyses.map((analysis) =>
          analysis.id === action.id
            ? { ...analysis, status: 'CANCELLED' }
            : analysis,
        ),
      };
  }
}

export function findOngoingAnalysis(
  items: AnalysisDto[],
): AnalysisDto | undefined {
  return items.find(
    (analysis) =>
      analysis.status === 'IN_PROGRESS' || analysis.status === 'PENDING',
  );
}

export function isAlreadyRunningError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return (
    message.includes('already running') ||
    message.includes('already in progress')
  );
}

export function buildStockAnalysisUrl(input: {
  symbol: string | null;
  stockId: string;
  analysisId: string;
}): string {
  return `/stock/${encodeURIComponent(input.symbol ?? '')}?stockId=${input.stockId}&analysisId=${input.analysisId}`;
}
