import { isSectionType } from '@bourse/shared-types';
import type { SectionType } from '@bourse/shared-types';

export interface AnalysisCitation {
  title: string;
  url: string;
  claim?: string;
  sectionType?: SectionType;
  searchAdapter?: string;
}

export interface SectionData {
  id?: string;
  type: SectionType;
  order: number;
  status: 'pending' | 'streaming' | 'completed' | 'failed' | 'skipped';
  markdown: string;
  structuredJson: any;
  citations: AnalysisCitation[];
  errorMessage?: string | null;
  skipReason?: string;
  skipMissingFields?: string[];
}

/**
 * Surfaced when EvidencePack dataAvailability reports WEB_SEARCH_FALLBACK.
 */
export interface DegradedInfo {
  kind: 'AUTH' | 'NETWORK' | 'RATE_LIMIT_HARD' | 'OTHER';
  failedTools: string[];
  message: string;
}

export interface AnalysisStreamState {
  status: 'idle' | 'streaming' | 'completed' | 'error';
  currentSection: SectionType | null;
  sections: Partial<Record<SectionType, SectionData>>;
  summaryMarkdown: string;
  summaryJson: any;
  error: string | null;
  analysisId: string | null;
  degraded: DegradedInfo | null;
  /**
   * True when another browser/process owns the live SSE run and this client is
   * polling for replay snapshots.
   */
  attachedElsewhere: boolean;
}

export const INITIAL_ANALYSIS_STREAM_STATE: AnalysisStreamState = {
  status: 'idle',
  currentSection: null,
  sections: {},
  summaryMarkdown: '',
  summaryJson: null,
  error: null,
  analysisId: null,
  degraded: null,
  attachedElsewhere: false,
};

export const ALREADY_RUNNING_RE = /already (running|in progress)/i;

export function startStreamState(
  state: AnalysisStreamState,
  analysisId: string,
): AnalysisStreamState {
  return {
    ...INITIAL_ANALYSIS_STREAM_STATE,
    status: 'streaming',
    analysisId,
    attachedElsewhere:
      state.analysisId === analysisId ? state.attachedElsewhere : false,
  };
}

export function stopWatchingStreamState(
  state: AnalysisStreamState,
): AnalysisStreamState {
  return {
    ...state,
    status: state.status === 'streaming' ? 'completed' : state.status,
    error: state.status === 'streaming' ? null : state.error,
    attachedElsewhere: false,
  };
}

export function markAttachedElsewhere(
  state: AnalysisStreamState,
): AnalysisStreamState {
  return {
    ...state,
    status: 'streaming',
    attachedElsewhere: true,
    error: null,
  };
}

export function markStreamConnectionError(
  state: AnalysisStreamState,
  message: string,
): AnalysisStreamState {
  if (state.attachedElsewhere) return state;
  return {
    ...state,
    status: 'error',
    error: message,
  };
}

export function isAlreadyRunningStreamError(message: unknown): boolean {
  return typeof message === 'string' && ALREADY_RUNNING_RE.test(message);
}

function parseSectionType(value: unknown): SectionType | null {
  return typeof value === 'string' && isSectionType(value) ? value : null;
}

export function applyAnalysisStreamEvent(
  state: AnalysisStreamState,
  event: string,
  data: any,
): AnalysisStreamState {
  switch (event) {
    case 'section_skipped': {
      const sectionType = parseSectionType(data.sectionType);
      if (!sectionType) return state;
      const existing = state.sections[sectionType];
      return {
        ...state,
        sections: {
          ...state.sections,
          [sectionType]: {
            id: existing?.id,
            type: sectionType,
            order: existing?.order ?? Object.keys(state.sections).length,
            status: 'skipped',
            markdown: '',
            structuredJson: null,
            citations: [],
            skipReason: data.reason,
            skipMissingFields: data.missingFields ?? [],
          },
        },
      };
    }

    case 'evidence_pack_ready': {
      const availability = data?.pack?.dataAvailability;
      if (availability?.degradedSource !== 'WEB_SEARCH_FALLBACK') return state;
      return {
        ...state,
        degraded: state.degraded ?? {
          kind: availability.fallbackReason?.kind ?? 'OTHER',
          failedTools: availability.fallbackReason?.failedTools ?? [],
          message: availability.fallbackReason?.message ?? '',
        },
      };
    }

    case 'section_start': {
      const sectionType = parseSectionType(data.sectionType);
      if (!sectionType) return state;
      const { order, sectionId } = data;
      return {
        ...state,
        currentSection: sectionType,
        sections: {
          ...state.sections,
          [sectionType]: {
            id: sectionId,
            type: sectionType,
            order,
            status: 'streaming',
            markdown: '',
            structuredJson: null,
            citations: [],
          },
        },
      };
    }

    case 'report_chunk': {
      const rawSectionType = data.sectionType;
      if (rawSectionType !== undefined && rawSectionType !== null) {
        const sectionType = parseSectionType(rawSectionType);
        if (!sectionType) return state;
        const existing = state.sections[sectionType];
        if (!existing) return state;
        return {
          ...state,
          sections: {
            ...state.sections,
            [sectionType]: {
              ...existing,
              markdown: existing.markdown + data.text,
            },
          },
        };
      }
      const currentSection = state.currentSection;
      if (!currentSection || !state.sections[currentSection]) return state;
      return {
        ...state,
        sections: {
          ...state.sections,
          [currentSection]: {
            ...state.sections[currentSection],
            markdown: state.sections[currentSection].markdown + data.text,
          },
        },
      };
    }

    case 'report_complete':
      return state;

    case 'structured_data': {
      const sectionType = parseSectionType(data.sectionType);
      if (!sectionType || !data.json || !state.sections[sectionType]) {
        return state;
      }
      return {
        ...state,
        sections: {
          ...state.sections,
          [sectionType]: {
            ...state.sections[sectionType],
            structuredJson: data.json,
          },
        },
      };
    }

    case 'citation': {
      const rawSectionType = data.sectionType;
      const sectionType =
        rawSectionType === undefined || rawSectionType === null
          ? null
          : parseSectionType(rawSectionType);
      if (rawSectionType !== undefined && rawSectionType !== null && !sectionType) {
        return state;
      }
      const targetType =
        sectionType && state.sections[sectionType]
          ? sectionType
          : state.currentSection;
      if (!targetType || !state.sections[targetType]) return state;
      const citation: AnalysisCitation = {
        title: data.title,
        url: data.url,
        claim: data.claim,
        ...(sectionType ? { sectionType } : {}),
        ...(data.searchAdapter ? { searchAdapter: data.searchAdapter } : {}),
      };
      return {
        ...state,
        sections: {
          ...state.sections,
          [targetType]: {
            ...state.sections[targetType],
            citations: [...state.sections[targetType].citations, citation],
          },
        },
      };
    }

    case 'section_complete': {
      const sectionType = parseSectionType(data.sectionType);
      const { status, error } = data;
      if (!sectionType) return state;
      if (!state.sections[sectionType]) return state;
      return {
        ...state,
        sections: {
          ...state.sections,
          [sectionType]: {
            ...state.sections[sectionType],
            status: status === 'COMPLETED' ? 'completed' : 'failed',
            errorMessage: error ?? null,
          },
        },
      };
    }

    case 'summary_chunk':
      return {
        ...state,
        summaryMarkdown: state.summaryMarkdown + data.text,
      };

    case 'summary_complete':
      return {
        ...state,
        summaryJson: data.summaryJson,
      };

    case 'done': {
      const terminal =
        typeof data?.status === 'string'
          ? (data.status as string).toUpperCase()
          : 'COMPLETED';
      const failed =
        terminal === 'FAILED' ||
        terminal === 'CANCELLED' ||
        terminal === 'BUDGET_EXHAUSTED';
      return {
        ...state,
        status: failed ? 'error' : 'completed',
        error: failed ? state.error || `Run ended in ${terminal}` : state.error,
        attachedElsewhere: false,
      };
    }

    case 'error':
      return markStreamConnectionError(state, data.message);

    default:
      return state;
  }
}
