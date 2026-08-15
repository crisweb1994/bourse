import type { Citation } from '../contracts/citation';
import type { OverallConclusion } from '../contracts/comprehensive-summary';
import type { AnalysisMode, FocusWindow, RunStatus, SectionType } from '../contracts/enums';
import type { EvidencePackV2 } from '../contracts/evidence-pack-v2';
import type { Trace } from '../contracts/trace';
import type {
  Dimension,
  DimensionInput,
  DimensionRunResult,
} from '../dimensions/types';
import type { MarketProfile } from '../markets/types';

export interface ComprehensiveOptions {
  runId: string;
  startSeq?: number;
  mode?: AnalysisMode;
  focusWindow?: FocusWindow;
  todayDate?: string;
  signal?: AbortSignal;
  dimensions?: readonly Dimension[];
  /** Completed module results from a prior attempt. These are included in
   * the summary context but are not executed again. */
  existingResults?: readonly DimensionRunResult[];
  waveMode?: 'auto' | 'sequential';
  waveSemaphore?: number;
  marketProfile?: MarketProfile;
  evidencePack?: EvidencePackV2;
}

export interface DimensionFailure {
  type: SectionType;
  error: string;
}

export interface ComprehensiveResult {
  status: RunStatus;
  perDimension: Map<SectionType, {
    type: SectionType;
    reportMarkdown: string;
    structuredJson: unknown;
    citations: Citation[];
    confidence: string;
    status: 'COMPLETED' | 'FAILED';
    warnings: string[];
    usage: { tokensIn: number; tokensOut: number };
  }>;
  failures: DimensionFailure[];
  skippedDimensions: SectionType[];
  partialDimensions: SectionType[];
  summary: { markdown: string; structured: OverallConclusion } | null;
  citations: Citation[];
  warnings: string[];
  trace: Trace;
}

export type { Dimension, DimensionInput };
