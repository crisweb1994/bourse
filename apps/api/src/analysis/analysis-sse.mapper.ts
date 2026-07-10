import type { SseEvent } from '@bourse/analysis';
import type {
  AnalysisSseEventName,
  AnalysisSsePayloadMap,
} from './analysis-sse.contract';

export type ApiSseFrame<T extends AnalysisSseEventName = AnalysisSseEventName> =
  {
    event: T;
    data: AnalysisSsePayloadMap[T];
  };

export function mapEvidencePackReadyEvent(
  event: Extract<SseEvent, { type: 'evidence_pack_ready' }>,
): ApiSseFrame<'evidence_pack_ready'> {
  return {
    event: 'evidence_pack_ready',
    data: { pack: event.pack },
  };
}

export function mapSectionSkippedEvent(
  event: Extract<SseEvent, { type: 'section_skipped' }>,
): ApiSseFrame<'section_skipped'> {
  return {
    event: 'section_skipped',
    data: {
      sectionType: event.sectionType,
      reason: event.reason,
      missingFields: event.missingFields,
    },
  };
}

export function mapSectionStartEvent(
  event: Extract<SseEvent, { type: 'section_start' }>,
  section: { id: string; order: number },
): ApiSseFrame<'section_start'> {
  return {
    event: 'section_start',
    data: {
      sectionType: event.sectionType,
      sectionId: section.id,
      order: event.order ?? section.order,
    },
  };
}

export function mapReportChunkEvent(
  event: Extract<SseEvent, { type: 'report_chunk' }>,
): ApiSseFrame<'report_chunk'> {
  return {
    event: 'report_chunk',
    data: {
      text: event.deltaText,
      sectionType: event.sectionType,
    },
  };
}

export function mapCitationEvent(
  event: Extract<SseEvent, { type: 'citation' }>,
): ApiSseFrame<'citation'> {
  return {
    event: 'citation',
    data: {
      title: event.citation.title,
      url: event.citation.url,
      claim: '',
      sectionType: event.sectionType,
      ...(event.citation.searchAdapter
        ? { searchAdapter: event.citation.searchAdapter }
        : {}),
    },
  };
}

export function mapStructuredDataEvent(
  event: Extract<SseEvent, { type: 'structured_data' }>,
): ApiSseFrame<'structured_data'> {
  return {
    event: 'structured_data',
    data: {
      json: event.json,
      sectionType: event.sectionType,
    },
  };
}

export function mapWebSearchWarningEvent(
  event: Extract<SseEvent, { type: 'web_search_warning' }>,
): ApiSseFrame<'web_search_warning'> {
  return {
    event: 'web_search_warning',
    data: {
      sectionType: event.sectionType,
      code: event.code,
      occurredAt: event.occurredAt,
      round: event.round,
    },
  };
}

export function mapSectionCompleteEvent(
  event: Extract<SseEvent, { type: 'section_complete' }>,
): ApiSseFrame<'section_complete'> {
  return {
    event: 'section_complete',
    data: {
      sectionType: event.sectionType,
      status: event.status,
    },
  };
}

export function mapSummaryChunkEvent(
  event: Extract<SseEvent, { type: 'summary_chunk' }>,
): ApiSseFrame<'summary_chunk'> {
  return {
    event: 'summary_chunk',
    data: { text: event.deltaText },
  };
}

export function mapSummaryCompleteEvent(
  event: Extract<SseEvent, { type: 'summary_complete' }>,
): ApiSseFrame<'summary_complete'> {
  return {
    event: 'summary_complete',
    data: { summaryJson: event.json },
  };
}

export function mapDoneEvent(
  analysisId: string,
  status: Extract<SseEvent, { type: 'done' }>['status'],
): ApiSseFrame<'done'> {
  return {
    event: 'done',
    data: { analysisId, status },
  };
}

export function mapErrorEvent(
  event: Extract<SseEvent, { type: 'error' }>,
): ApiSseFrame<'error'> {
  return {
    event: 'error',
    data: {
      message: event.message,
      ...(event.sectionType ? { failedSections: [event.sectionType] } : {}),
    },
  };
}

export function mapThrownError(
  message: string,
): ApiSseFrame<'error'> {
  return {
    event: 'error',
    data: { message },
  };
}
