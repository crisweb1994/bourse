import { Injectable } from '@nestjs/common';
import {
  isTerminalAnalysisStatus,
  type AnalysisStatus,
  type SectionType,
} from '@bourse/shared-types';
import type { SseCallback } from './types';

interface ReplayCitation {
  title?: string;
  url?: string;
  claim?: string;
}

interface ReplaySection {
  id: string;
  type: SectionType;
  order: number;
  status: AnalysisStatus;
  reportMarkdown?: string | null;
  structuredJson?: unknown;
  citations?: unknown;
  errorMessage?: string | null;
}

interface ReplayAnalysis {
  id: string;
  analysisType: string;
  status: AnalysisStatus;
  summaryMarkdown?: string | null;
  summaryJson?: unknown;
  sections: ReplaySection[];
}

@Injectable()
export class AnalysisReplayService {
  /**
   * Replay a still-running analysis as a progress snapshot. This emits no
   * summary and no done event; the caller decides how the client should poll
   * or attach after the snapshot.
   */
  replayInProgressRun(analysis: ReplayAnalysis, send: SseCallback) {
    for (const section of analysis.sections) {
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

      if (!isTerminalAnalysisStatus(section.status)) continue;

      this.replaySectionDetails(section, send);
      send('section_complete', {
        sectionType: section.type,
        status: section.status,
        error: section.errorMessage ?? null,
      });
    }
  }

  replayTerminalRun(analysis: ReplayAnalysis, send: SseCallback) {
    for (const section of analysis.sections) {
      this.replayTerminalSection(section, send);
    }

    if (analysis.analysisType === 'COMPREHENSIVE' && analysis.summaryMarkdown) {
      send('summary_chunk', { text: analysis.summaryMarkdown });
      if (analysis.summaryJson) {
        send('summary_complete', { summaryJson: analysis.summaryJson });
      }
    }

    send('done', { analysisId: analysis.id, status: analysis.status });
  }

  private replayTerminalSection(section: ReplaySection, send: SseCallback) {
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

    this.replaySectionDetails(section, send);
    send('section_complete', {
      sectionType: section.type,
      status: section.status,
      error: section.errorMessage ?? null,
    });
  }

  private replaySectionDetails(section: ReplaySection, send: SseCallback) {
    const citations = this.replayCitations(section.citations);
    for (const citation of citations) {
      send('citation', {
        title: citation.title ?? '',
        url: citation.url ?? '',
        claim: citation.claim || '',
        sectionType: section.type,
      });
    }

    if (section.structuredJson) {
      send('structured_data', {
        json: section.structuredJson,
        sectionType: section.type,
      });
    }
  }

  private replayCitations(value: unknown): ReplayCitation[] {
    return Array.isArray(value) ? (value as ReplayCitation[]) : [];
  }
}
