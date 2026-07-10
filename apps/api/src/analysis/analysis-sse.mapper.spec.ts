import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { SseEvent } from '@bourse/analysis';
import {
  mapCitationEvent,
  mapErrorEvent,
  mapSectionStartEvent,
  mapSummaryCompleteEvent,
  mapSummaryChunkEvent,
  mapThrownError,
} from './analysis-sse.mapper';

function event<T extends SseEvent['type']>(
  type: T,
  rest: Record<string, unknown>,
): Extract<SseEvent, { type: T }> {
  return {
    type,
    runId: 'run-test',
    seq: 1,
    ...rest,
  } as Extract<SseEvent, { type: T }>;
}

describe('analysis SSE mapper', () => {
  it('maps citation provenance into the API citation contract', () => {
    const frame = mapCitationEvent(
      event('citation', {
        sectionType: 'FUNDAMENTAL',
        citation: {
          title: '10-K',
          url: 'https://example.com/filing',
          sourceType: 'FILING',
          retrievedAt: '2026-07-09T00:00:00.000Z',
          searchAdapter: 'searxng',
        },
      }),
    );

    assert.equal(frame.event, 'citation');
    assert.deepEqual(frame.data, {
      title: '10-K',
      url: 'https://example.com/filing',
      claim: '',
      sectionType: 'FUNDAMENTAL',
      searchAdapter: 'searxng',
    });
  });

  it('maps section_start with the database section id', () => {
    const frame = mapSectionStartEvent(
      event('section_start', {
        sectionType: 'VALUATION',
        order: 2,
      }),
      { id: 'section-db-id', order: 9 },
    );

    assert.deepEqual(frame, {
      event: 'section_start',
      data: {
        sectionType: 'VALUATION',
        sectionId: 'section-db-id',
        order: 2,
      },
    });
  });

  it('maps summary frames to the frontend-only summary contract', () => {
    const chunk = mapSummaryChunkEvent(
      event('summary_chunk', { deltaText: '总体 ' }),
    );
    const complete = mapSummaryCompleteEvent(
      event('summary_complete', {
        fullMarkdown: '总体 偏多',
        json: { overallSignal: 'BULLISH' },
      }),
    );

    assert.deepEqual(chunk, {
      event: 'summary_chunk',
      data: { text: '总体 ' },
    });
    assert.deepEqual(complete, {
      event: 'summary_complete',
      data: { summaryJson: { overallSignal: 'BULLISH' } },
    });
  });

  it('maps section-scoped errors into failedSections', () => {
    const frame = mapErrorEvent(
      event('error', {
        sectionType: 'INDUSTRY',
        message: 'provider failed',
        recoverable: false,
      }),
    );

    assert.deepEqual(frame, {
      event: 'error',
      data: {
        message: 'provider failed',
        failedSections: ['INDUSTRY'],
      },
    });
  });

  it('maps thrown errors without failedSections', () => {
    assert.deepEqual(mapThrownError('boom'), {
      event: 'error',
      data: { message: 'boom' },
    });
  });

});
