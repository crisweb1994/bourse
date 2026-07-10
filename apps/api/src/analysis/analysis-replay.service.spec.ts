import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AnalysisReplayService } from './analysis-replay.service';
import type { AnalysisSseEventName } from './analysis-sse.contract';

interface SentFrame {
  event: AnalysisSseEventName;
  data: unknown;
}

function collectFrames() {
  const frames: SentFrame[] = [];
  return {
    frames,
    send: ((event: AnalysisSseEventName, data: unknown) => {
      frames.push({ event, data });
    }) as never,
  };
}

describe('AnalysisReplayService', () => {
  it('replays terminal section statuses in an in-progress snapshot', () => {
    const service = new AnalysisReplayService();
    const { frames, send } = collectFrames();

    service.replayInProgressRun(
      {
        id: 'analysis-1',
        analysisType: 'COMPREHENSIVE',
        status: 'IN_PROGRESS',
        sections: [
          {
            id: 'section-cancelled',
            type: 'FUNDAMENTAL',
            order: 0,
            status: 'CANCELLED',
            reportMarkdown: 'cancelled text',
            structuredJson: { signal: 'NEUTRAL' },
            citations: [{ title: 'Source', url: 'https://example.com' }],
            errorMessage: 'Manually cancelled by user',
          },
          {
            id: 'section-budget',
            type: 'VALUATION',
            order: 1,
            status: 'BUDGET_EXHAUSTED',
            errorMessage: 'Run budget exhausted before this section completed',
          },
          {
            id: 'section-running',
            type: 'RISK',
            order: 2,
            status: 'IN_PROGRESS',
            reportMarkdown: 'still running',
          },
        ],
      },
      send,
    );

    const completedFrames = frames.filter(
      (frame) => frame.event === 'section_complete',
    );
    assert.deepEqual(completedFrames, [
      {
        event: 'section_complete',
        data: {
          sectionType: 'FUNDAMENTAL',
          status: 'CANCELLED',
          error: 'Manually cancelled by user',
        },
      },
      {
        event: 'section_complete',
        data: {
          sectionType: 'VALUATION',
          status: 'BUDGET_EXHAUSTED',
          error: 'Run budget exhausted before this section completed',
        },
      },
    ]);
  });

  it('includes terminal status on terminal run replay done', () => {
    const service = new AnalysisReplayService();
    const { frames, send } = collectFrames();

    service.replayTerminalRun(
      {
        id: 'analysis-2',
        analysisType: 'COMPREHENSIVE',
        status: 'FAILED',
        sections: [],
      },
      send,
    );

    assert.deepEqual(frames.at(-1), {
      event: 'done',
      data: { analysisId: 'analysis-2', status: 'FAILED' },
    });
  });
});
