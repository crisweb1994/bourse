import { isSectionType } from '@bourse/shared-types';
import type { AnalysisStatus, SectionStatus, SectionType } from '@bourse/shared-types';

export interface AnalysisCitation {
  title: string;
  url: string;
  claim?: string;
  sectionType?: SectionType;
  searchAdapter?: string;
  retrievedAt?: string;
}

export type SectionUiStatus =
  | 'pending'
  | 'streaming'
  | 'completed'
  | 'failed'
  | 'skipped'
  | 'cancelled';

export interface SectionData {
  id?: string;
  type: SectionType;
  order: number;
  status: SectionUiStatus;
  markdown: string;
  structuredJson: any;
  citations: AnalysisCitation[];
  errorMessage?: string | null;
  skipReason?: string;
  skipMissingFields?: string[];
}

export interface AnalysisStreamEventPayloadMap {
  evidence_pack_ready: { pack: unknown };
  section_skipped: {
    sectionType: SectionType;
    reason: string;
    missingFields: string[];
  };
  section_start: {
    sectionType: SectionType;
    sectionId: string;
    order: number;
  };
  report_chunk: { text: string; sectionType?: SectionType };
  report_complete: { text: string; sectionType: SectionType };
  citation: {
    title: string;
    url: string;
    claim: string;
    sectionType?: SectionType;
    searchAdapter?: string;
    retrievedAt?: string;
  };
  structured_data: { json: unknown; sectionType: SectionType };
  section_complete: {
    sectionType: SectionType;
    status: SectionStatus;
    error?: string | null;
  };
  summary_chunk: { text: string };
  summary_complete: { summaryJson: unknown };
  cost_update: { totalTokens: number; toolCalls: number };
  done: { analysisId: string; status?: AnalysisStatus };
  error: { message: string; failedSections?: SectionType[]; sectionType?: SectionType };
}

export type AnalysisStreamEventName = keyof AnalysisStreamEventPayloadMap;

const ANALYSIS_STREAM_EVENT_NAMES = [
  'evidence_pack_ready',
  'section_skipped',
  'section_start',
  'report_chunk',
  'report_complete',
  'citation',
  'structured_data',
  'section_complete',
  'summary_chunk',
  'summary_complete',
  'cost_update',
  'done',
  'error',
] as const satisfies readonly AnalysisStreamEventName[];

const ANALYSIS_STREAM_EVENT_NAME_SET = new Set<string>(ANALYSIS_STREAM_EVENT_NAMES);

export function isAnalysisStreamEventName(value: string): value is AnalysisStreamEventName {
  return ANALYSIS_STREAM_EVENT_NAME_SET.has(value);
}

export interface DegradedInfo {
  kind: 'AUTH' | 'NETWORK' | 'RATE_LIMIT_HARD' | 'OTHER';
  failedTools: string[];
  message: string;
}

export interface AnalysisStreamState {
  status: 'idle' | 'streaming' | 'completed' | 'error' | 'cancelled';
  terminalStatus: AnalysisStatus | null;
  currentSection: SectionType | null;
  sections: Partial<Record<SectionType, SectionData>>;
  summaryMarkdown: string;
  summaryJson: any;
  error: string | null;
  analysisId: string | null;
  degraded: DegradedInfo | null;
  usage: { totalTokens: number; toolCalls: number } | null;
  attachedElsewhere: boolean;
}

export const INITIAL_ANALYSIS_STREAM_STATE: AnalysisStreamState = {
  status: 'idle',
  terminalStatus: null,
  currentSection: null,
  sections: {},
  summaryMarkdown: '',
  summaryJson: null,
  error: null,
  analysisId: null,
  degraded: null,
  usage: null,
  attachedElsewhere: false,
};

export const ALREADY_RUNNING_RE = /already (running|in progress)/i;

export function startStreamState(state: AnalysisStreamState, analysisId: string): AnalysisStreamState {
  return {
    ...INITIAL_ANALYSIS_STREAM_STATE,
    status: 'streaming',
    analysisId,
    attachedElsewhere: state.analysisId === analysisId ? state.attachedElsewhere : false,
  };
}

export function stopWatchingStreamState(
  state: AnalysisStreamState,
  terminalStatus: 'COMPLETED' | 'CANCELLED' = 'COMPLETED',
): AnalysisStreamState {
  if (state.status !== 'streaming') {
    return {
      ...state,
      status: terminalStatus === 'CANCELLED' ? 'cancelled' : state.status,
      terminalStatus,
      attachedElsewhere: false,
    };
  }
  return {
    ...state,
    status: terminalStatus === 'CANCELLED' ? 'cancelled' : 'completed',
    terminalStatus,
    error: null,
    attachedElsewhere: false,
  };
}

export function markAttachedElsewhere(state: AnalysisStreamState): AnalysisStreamState {
  return { ...state, status: 'streaming', attachedElsewhere: true, error: null };
}

export function markStreamConnectionError(state: AnalysisStreamState, message: string): AnalysisStreamState {
  if (state.attachedElsewhere) return state;
  return { ...state, status: 'error', error: message };
}

export function isAlreadyRunningStreamError(message: unknown): boolean {
  return typeof message === 'string' && ALREADY_RUNNING_RE.test(message);
}

function parseSectionType(value: unknown): SectionType | null {
  return typeof value === 'string' && isSectionType(value) ? value : null;
}

function parseDegradedInfo(pack: unknown): DegradedInfo | null {
  if (!pack || typeof pack !== 'object') return null;
  const raw = pack as {
    degraded?: unknown;
    dataAvailability?: {
      degradedSource?: unknown;
      fallbackReason?: { kind?: DegradedInfo['kind']; failedTools?: string[]; message?: string };
      missing?: unknown[];
    };
  };
  const availability = raw.dataAvailability;
  const isDegraded = raw.degraded === true || availability?.degradedSource === 'WEB_SEARCH_FALLBACK';
  if (!isDegraded) return null;
  return {
    kind: availability?.fallbackReason?.kind ?? 'OTHER',
    failedTools: availability?.fallbackReason?.failedTools ?? [],
    message:
      availability?.fallbackReason?.message ??
      (availability?.missing?.length ? '部分数据源不可用' : '证据数据已降级'),
  };
}

function sectionStatusToUi(status: SectionStatus): SectionUiStatus {
  switch (status) {
    case 'COMPLETED': return 'completed';
    case 'FAILED': return 'failed';
    case 'SKIPPED': return 'skipped';
    case 'CANCELLED': return 'cancelled';
    case 'IN_PROGRESS': return 'streaming';
    default: return 'pending';
  }
}

export function applyAnalysisStreamEvent(
  state: AnalysisStreamState,
  event: string,
  data: any,
): AnalysisStreamState {
  switch (event) {
    case 'evidence_pack_ready': {
      const degraded = parseDegradedInfo(data.pack);
      return degraded && !state.degraded ? { ...state, degraded } : state;
    }
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
            skipMissingFields: Array.isArray(data.missingFields) ? data.missingFields : [],
          },
        },
      };
    }
    case 'section_start': {
      const sectionType = parseSectionType(data.sectionType);
      if (!sectionType) return state;
      return {
        ...state,
        currentSection: sectionType,
        sections: {
          ...state.sections,
          [sectionType]: {
            id: data.sectionId,
            type: sectionType,
            order: Number.isInteger(data.order) ? data.order : Object.keys(state.sections).length,
            status: 'streaming',
            markdown: '',
            structuredJson: null,
            citations: [],
          },
        },
      };
    }
    case 'report_chunk': {
      const explicit = data.sectionType == null ? null : parseSectionType(data.sectionType);
      const target = explicit ?? state.currentSection;
      if (!target || !state.sections[target] || typeof data.text !== 'string') return state;
      return {
        ...state,
        sections: {
          ...state.sections,
          [target]: { ...state.sections[target]!, markdown: state.sections[target]!.markdown + data.text },
        },
      };
    }
    case 'report_complete': {
      const sectionType = parseSectionType(data.sectionType);
      if (!sectionType || !state.sections[sectionType] || typeof data.text !== 'string') return state;
      return {
        ...state,
        sections: {
          ...state.sections,
          [sectionType]: { ...state.sections[sectionType]!, markdown: data.text },
        },
      };
    }
    case 'structured_data': {
      const sectionType = parseSectionType(data.sectionType);
      if (!sectionType || !state.sections[sectionType]) return state;
      return { ...state, sections: { ...state.sections, [sectionType]: { ...state.sections[sectionType]!, structuredJson: data.json } } };
    }
    case 'citation': {
      const sectionType = data.sectionType == null ? state.currentSection : parseSectionType(data.sectionType);
      if (!sectionType || !state.sections[sectionType] || typeof data.url !== 'string') return state;
      const existing = state.sections[sectionType]!;
      if (existing.citations.some((citation) => citation.url === data.url)) return state;
      return {
        ...state,
        sections: {
          ...state.sections,
          [sectionType]: {
            ...existing,
            citations: [...existing.citations, {
              title: typeof data.title === 'string' ? data.title : data.url,
              url: data.url,
              claim: typeof data.claim === 'string' ? data.claim : undefined,
              sectionType,
              searchAdapter: data.searchAdapter,
              retrievedAt: data.retrievedAt,
            }],
          },
        },
      };
    }
    case 'section_complete': {
      const sectionType = parseSectionType(data.sectionType);
      if (!sectionType || !state.sections[sectionType]) return state;
      const failed = data.status !== 'COMPLETED';
      return {
        ...state,
        sections: {
          ...state.sections,
          [sectionType]: {
            ...state.sections[sectionType]!,
            status: sectionStatusToUi(data.status),
            ...(failed
              ? { markdown: '', structuredJson: null, citations: [] }
              : {}),
            errorMessage: data.error ?? state.sections[sectionType]!.errorMessage ?? null,
          },
        },
      };
    }
    case 'summary_chunk':
      return { ...state, summaryMarkdown: state.summaryMarkdown + (typeof data.text === 'string' ? data.text : '') };
    case 'summary_complete':
      return { ...state, summaryJson: data.summaryJson ?? null };
    case 'cost_update':
      return typeof data.totalTokens === 'number'
        ? { ...state, usage: { totalTokens: data.totalTokens, toolCalls: typeof data.toolCalls === 'number' ? data.toolCalls : 0 } }
        : state;
    case 'done': {
      const terminal = typeof data.status === 'string' ? data.status.toUpperCase() as AnalysisStatus : 'COMPLETED';
      if (terminal === 'CANCELLED') return { ...state, status: 'cancelled', terminalStatus: terminal, error: null, attachedElsewhere: false };
      if (terminal === 'FAILED' || terminal === 'PARTIAL_FAILED') {
        return {
          ...state,
          status: 'error',
          terminalStatus: terminal,
          error: state.error ?? (terminal === 'PARTIAL_FAILED' ? '研究部分完成' : '研究失败'),
          attachedElsewhere: false,
        };
      }
      return { ...state, status: 'completed', terminalStatus: terminal, attachedElsewhere: false };
    }
    case 'error': {
      const next = markStreamConnectionError(
        state,
        typeof data.message === 'string' ? data.message : '研究连接失败',
      );
      const sectionType = parseSectionType(data.sectionType);
      if (!sectionType || !state.sections[sectionType]) return next;
      return {
        ...next,
        sections: {
          ...next.sections,
          [sectionType]: {
            ...next.sections[sectionType]!,
            errorMessage: typeof data.message === 'string' ? data.message : '研究失败',
          },
        },
      };
    }
    default:
      return state;
  }
}
