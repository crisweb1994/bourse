import { Injectable } from '@nestjs/common';
import type { SectionStatus, SectionType, AnalysisStatus } from '@bourse/shared-types';
import type { SseCallback } from './types';

interface ReplaySection {
  id: string;
  type: SectionType;
  order: number;
  status: SectionStatus;
  reportMarkdown?: string | null;
  structuredJson?: unknown;
  errorMessage?: string | null;
}

interface ReplayEvidenceSnapshot {
  capturedAt: Date | string;
  dataAsOf: unknown;
  degraded: boolean;
  missingFields: string[];
  sourceMode?: string;
}

interface ReplayAnalysis {
  id: string;
  status: AnalysisStatus;
  summaryMarkdown?: string | null;
  summaryJson?: unknown;
  sections: ReplaySection[];
  evidenceSnapshot?: ReplayEvidenceSnapshot | null;
}

const TERMINAL_SECTION_STATUSES = new Set<SectionStatus>([
  'COMPLETED',
  'FAILED',
  'SKIPPED',
  'CANCELLED',
]);

@Injectable()
export class AnalysisReplayService {
  replayInProgressRun(analysis: ReplayAnalysis, send: SseCallback) {
    this.replayEvidenceSnapshot(analysis.evidenceSnapshot, send);
    for (const section of analysis.sections) {
      this.replaySection(section, send, false);
    }
  }

  replayTerminalRun(analysis: ReplayAnalysis, send: SseCallback) {
    this.replayEvidenceSnapshot(analysis.evidenceSnapshot, send);
    for (const section of analysis.sections) {
      this.replaySection(section, send, true);
    }
    if (analysis.summaryMarkdown) {
      send('summary_chunk', { text: analysis.summaryMarkdown });
    }
    if (analysis.summaryJson) {
      send('summary_complete', { summaryJson: analysis.summaryJson });
    }
    send('done', { analysisId: analysis.id, status: analysis.status });
  }

  private replayEvidenceSnapshot(
    snapshot: ReplayEvidenceSnapshot | null | undefined,
    send: SseCallback,
  ) {
    if (!snapshot) return;
    send('evidence_pack_ready', {
      pack: {
        capturedAt:
          snapshot.capturedAt instanceof Date
            ? snapshot.capturedAt.toISOString()
            : snapshot.capturedAt,
        dataAsOf: snapshot.dataAsOf,
        degraded: snapshot.degraded,
        missingFields: snapshot.missingFields,
      },
    });
  }

  private replaySection(
    section: ReplaySection,
    send: SseCallback,
    forceComplete: boolean,
  ) {
    send('section_start', {
      sectionType: section.type,
      sectionId: section.id,
      order: section.order,
    });
    if (section.reportMarkdown) {
      send('report_chunk', {
        text: section.reportMarkdown,
        sectionType: section.type,
      });
    }
    if (!forceComplete && !TERMINAL_SECTION_STATUSES.has(section.status)) return;
    this.replayStructuredCitations(section, send);
    send('section_complete', {
      sectionType: section.type,
      status: section.status,
      error: section.errorMessage ?? null,
    });
  }

  private replayStructuredCitations(section: ReplaySection, send: SseCallback) {
    const data = section.structuredJson as any;
    const findings = Array.isArray(data?.findings) ? data.findings : [];
    for (const finding of findings) {
      for (const evidence of Array.isArray(finding?.evidence) ? finding.evidence : []) {
        for (const citation of Array.isArray(evidence?.citations) ? evidence.citations : []) {
          if (typeof citation?.url !== 'string') continue;
          send('citation', {
            title: typeof citation.title === 'string' ? citation.title : citation.url,
            url: citation.url,
            claim: typeof evidence.claim === 'string' ? evidence.claim : '',
            sectionType: section.type,
            ...(typeof citation.sourceType === 'string'
              ? { sourceType: citation.sourceType }
              : {}),
            ...(typeof citation.retrievedAt === 'string'
              ? { retrievedAt: citation.retrievedAt }
              : {}),
          });
        }
      }
    }
    if (section.structuredJson) {
      send('structured_data', {
        json: section.structuredJson,
        sectionType: section.type,
      });
    }
  }
}
