import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { AnalysisStatus, SectionStatus, SectionType } from '@bourse/shared-types';
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

const section = (input: Partial<{
  id: string;
  type: SectionType;
  order: number;
  status: SectionStatus;
  reportMarkdown: string;
  structuredJson: unknown;
  errorMessage: string | null;
}> = {}) => ({
  id: input.id ?? 'section-1',
  type: input.type ?? 'COMPANY_QUALITY',
  order: input.order ?? 0,
  status: input.status ?? 'COMPLETED',
  ...(input.reportMarkdown !== undefined
    ? { reportMarkdown: input.reportMarkdown }
    : {}),
  ...(input.structuredJson !== undefined
    ? { structuredJson: input.structuredJson }
    : {}),
  ...(input.errorMessage !== undefined
    ? { errorMessage: input.errorMessage }
    : {}),
});

describe('AnalysisReplayService', () => {
  it('replays snapshot metadata and terminal section states for an in-progress run', () => {
    const service = new AnalysisReplayService();
    const { frames, send } = collectFrames();

    service.replayInProgressRun(
      {
        id: 'analysis-1',
        status: 'IN_PROGRESS' as AnalysisStatus,
        evidenceSnapshot: {
          capturedAt: new Date('2026-07-09T00:00:00.000Z'),
          dataAsOf: '2026-07-08',
          degraded: true,
          missingFields: ['cashFlow'],
        },
        sections: [
          section({
            id: 'section-company',
            type: 'COMPANY_QUALITY',
            order: 0,
            status: 'COMPLETED',
            reportMarkdown: 'quality',
            structuredJson: {
              findings: [
                {
                  evidence: [
                    {
                      claim: 'Revenue grew',
                      citations: [{ title: 'Filing', url: 'https://example.com/filing' }],
                    },
                  ],
                },
              ],
            },
          }),
          section({
            id: 'section-risk',
            type: 'RISK_REGISTER',
            order: 3,
            status: 'FAILED',
            errorMessage: 'provider failed',
          }),
          section({
            id: 'section-market',
            type: 'MARKET_SIGNALS',
            order: 4,
            status: 'IN_PROGRESS',
            reportMarkdown: 'partial',
          }),
        ],
      },
      send,
    );

    assert.deepEqual(frames[0], {
      event: 'evidence_pack_ready',
      data: {
        pack: {
          capturedAt: '2026-07-09T00:00:00.000Z',
          dataAsOf: '2026-07-08',
          degraded: true,
          missingFields: ['cashFlow'],
        },
      },
    });
    assert.deepEqual(
      frames.filter((frame) => frame.event === 'section_complete'),
      [
        {
          event: 'section_complete',
          data: {
            sectionType: 'COMPANY_QUALITY',
            status: 'COMPLETED',
            error: null,
          },
        },
        {
          event: 'section_complete',
          data: {
            sectionType: 'RISK_REGISTER',
            status: 'FAILED',
            error: 'provider failed',
          },
        },
      ],
    );
    assert.equal(
      frames.some(
        (frame) =>
          frame.event === 'section_complete' &&
          (frame.data as any).sectionType === 'MARKET_SIGNALS',
      ),
      false,
    );
    assert.deepEqual(
      frames.find((frame) => frame.event === 'citation')?.data,
      {
        title: 'Filing',
        url: 'https://example.com/filing',
        claim: 'Revenue grew',
        sectionType: 'COMPANY_QUALITY',
      },
    );
  });

  it('replays a terminal V2 run including all completed data and summary', () => {
    const service = new AnalysisReplayService();
    const { frames, send } = collectFrames();

    service.replayTerminalRun(
      {
        id: 'analysis-2',
        status: 'PARTIAL_FAILED' as AnalysisStatus,
        sections: [
          section({
            id: 'section-valuation',
            type: 'VALUATION_SCENARIOS',
            order: 2,
            status: 'COMPLETED',
            reportMarkdown: 'valuation',
            structuredJson: { signal: 'NEUTRAL' },
          }),
          section({
            id: 'section-industry',
            type: 'INDUSTRY_POSITION',
            order: 1,
            status: 'SKIPPED',
            errorMessage: 'Missing required facts',
          }),
          section({
            id: 'section-risk',
            type: 'RISK_REGISTER',
            order: 3,
            status: 'CANCELLED',
            errorMessage: 'Cancelled by user',
          }),
        ],
        summaryMarkdown: '总体判断',
        summaryJson: { signal: 'NEUTRAL', confidence: 'LOW' },
      },
      send,
    );

    assert.deepEqual(
      frames.filter((frame) => frame.event === 'section_start').map((frame) => frame.data),
      [
        { sectionType: 'VALUATION_SCENARIOS', sectionId: 'section-valuation', order: 2 },
        { sectionType: 'INDUSTRY_POSITION', sectionId: 'section-industry', order: 1 },
        { sectionType: 'RISK_REGISTER', sectionId: 'section-risk', order: 3 },
      ],
    );
    assert.deepEqual(
      frames.filter((frame) => frame.event === 'section_complete').map((frame) => frame.data),
      [
        { sectionType: 'VALUATION_SCENARIOS', status: 'COMPLETED', error: null },
        { sectionType: 'INDUSTRY_POSITION', status: 'SKIPPED', error: 'Missing required facts' },
        { sectionType: 'RISK_REGISTER', status: 'CANCELLED', error: 'Cancelled by user' },
      ],
    );
    assert.deepEqual(
      frames.filter((frame) => frame.event === 'section_skipped').map((frame) => frame.data),
      [{
        sectionType: 'INDUSTRY_POSITION',
        reason: 'INSUFFICIENT_REQUIRED_FACTS',
        missingFields: [],
      }],
    );
    assert.deepEqual(frames.at(-3), {
      event: 'summary_chunk',
      data: { text: '总体判断' },
    });
    assert.deepEqual(frames.at(-2), {
      event: 'summary_complete',
      data: { summaryJson: { signal: 'NEUTRAL', confidence: 'LOW' } },
    });
    assert.deepEqual(frames.at(-1), {
      event: 'done',
      data: { analysisId: 'analysis-2', status: 'PARTIAL_FAILED' },
    });
  });

  it('does not replay summary fields when a terminal run has no summary', () => {
    const service = new AnalysisReplayService();
    const { frames, send } = collectFrames();

    service.replayTerminalRun(
      {
        id: 'analysis-3',
        status: 'FAILED' as AnalysisStatus,
        sections: [],
      },
      send,
    );

    assert.deepEqual(frames, [
      { event: 'done', data: { analysisId: 'analysis-3', status: 'FAILED' } },
    ]);
  });

  it('normalizes a persisted JSON summary before replaying it', () => {
    const service = new AnalysisReplayService();
    const { frames, send } = collectFrames();
    const summary = {
      headline: '综合看法中性',
      signal: null,
      confidence: 'LOW',
      rationale: [],
      counterpoints: [],
      changeConditions: [],
      missingSections: [],
      dataAsOf: '2026-01-15',
      disclaimer: '免责声明',
    };

    service.replayTerminalRun(
      {
        id: 'analysis-4',
        status: 'COMPLETED' as AnalysisStatus,
        sections: [],
        summaryMarkdown: JSON.stringify(summary),
        summaryJson: summary,
      },
      send,
    );

    const summaryFrame = frames.find((frame) => frame.event === 'summary_chunk');
    const summaryText = (summaryFrame?.data as { text?: unknown } | undefined)?.text;
    assert.equal(typeof summaryText === 'string' && summaryText.startsWith('{'), false);
    assert.equal(typeof summaryText === 'string' && summaryText.includes('综合看法中性'), true);
  });
});
