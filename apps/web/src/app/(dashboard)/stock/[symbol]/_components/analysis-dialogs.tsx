'use client';

import { type AnalysisHistoryItemDto } from '@/lib/api';
import { CompareDialog } from './compare-dialog';
import { ConflictDialog } from './conflict-dialog';

interface AnalysisDialogsProps {
  compareOpen: boolean;
  onCompareOpenChange: (open: boolean) => void;
  currentAnalysis: AnalysisHistoryItemDto | null;
  currentSummary: unknown;
  recentAnalyses: AnalysisHistoryItemDto[];
  conflictAnalysis: AnalysisHistoryItemDto | null;
  onDismissConflict: () => void;
  onViewConflict: () => void;
  onCancelAndNew: () => void;
}

export function AnalysisDialogs({
  compareOpen,
  onCompareOpenChange,
  currentAnalysis,
  currentSummary,
  recentAnalyses,
  conflictAnalysis,
  onDismissConflict,
  onViewConflict,
  onCancelAndNew,
}: AnalysisDialogsProps) {
  return (
    <>
      {compareOpen && currentAnalysis && (
        <CompareDialog
          open={compareOpen}
          onClose={() => onCompareOpenChange(false)}
          current={currentAnalysis}
          currentSummary={currentSummary}
          recents={recentAnalyses}
        />
      )}

      {conflictAnalysis && (
        <ConflictDialog
          open={!!conflictAnalysis}
          onClose={onDismissConflict}
          ongoing={conflictAnalysis}
          onView={onViewConflict}
          onCancelAndNew={onCancelAndNew}
        />
      )}
    </>
  );
}
