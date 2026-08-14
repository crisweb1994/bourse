import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { SseEvent } from '@bourse/analysis';
import {
  mapCitationEvent,
  mapDoneEvent,
  mapErrorEvent,
  mapEvidencePackReadyEvent,
  mapSectionCompleteEvent,
  mapSectionSkippedEvent,
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
  it('maps evidence snapshot availability into the public API shape', () => {
    const frame = mapEvidencePackReadyEvent(
      event('evidence_pack_ready', {
        pack: {
          capturedAt: '2026-07-09T00:00:00.000Z',
          dataAsOf: '2026-07-08',
          dataAvailability: {
            degradedSource: 'WEB_SEARCH_FALLBACK',
            missing: ['cashFlow'],
          },
        },
      }),
    );

    assert.deepEqual(frame, {
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
  });

  it('maps citations with V2 provenance and module type', () => {
    const frame = mapCitationEvent(
      event('citation', {
        sectionType: 'COMPANY_QUALITY',
        citation: {
          title: '10-K',
          url: 'https://example.com/filing',
          sourceType: 'FILING',
          retrievedAt: '2026-07-09T00:00:00.000Z',
          searchAdapter: 'searxng',
        },
      }),
    );

    assert.deepEqual(frame, {
      event: 'citation',
      data: {
        title: '10-K',
        url: 'https://example.com/filing',
        claim: '',
        sectionType: 'COMPANY_QUALITY',
        retrievedAt: '2026-07-09T00:00:00.000Z',
        sourceType: 'FILING',
        searchAdapter: 'searxng',
      },
    });
  });

  it('maps section start and terminal statuses for all V2 modules', () => {
    const start = mapSectionStartEvent(
      event('section_start', {
        sectionType: 'VALUATION_SCENARIOS',
        order: 2,
      }),
      { id: 'section-db-id', order: 9 },
    );
    assert.deepEqual(start, {
      event: 'section_start',
      data: {
        sectionType: 'VALUATION_SCENARIOS',
        sectionId: 'section-db-id',
        order: 2,
      },
    });

    for (const status of ['COMPLETED', 'FAILED', 'SKIPPED', 'CANCELLED'] as const) {
      const frame = mapSectionCompleteEvent(
        event('section_complete', {
          sectionType: 'RISK_REGISTER',
          status,
        }),
      );
      assert.deepEqual(frame.data, {
        sectionType: 'RISK_REGISTER',
        status,
        ...(status !== 'COMPLETED' ? { error: null } : {}),
      });
    }
  });

  it('maps an intentional section skip with missing fields', () => {
    const frame = mapSectionSkippedEvent(
      event('section_skipped', {
        sectionType: 'INDUSTRY_POSITION',
        reason: 'INSUFFICIENT_REQUIRED_FACTS',
        missingFields: ['peerSet'],
      }),
    );
    assert.deepEqual(frame, {
      event: 'section_skipped',
      data: {
        sectionType: 'INDUSTRY_POSITION',
        reason: 'INSUFFICIENT_REQUIRED_FACTS',
        missingFields: ['peerSet'],
      },
    });
  });

  it('maps summary, terminal, and error frames', () => {
    assert.deepEqual(
      mapSummaryChunkEvent(event('summary_chunk', { deltaText: '总体 ' })),
      { event: 'summary_chunk', data: { text: '总体 ' } },
    );
    assert.deepEqual(
      mapSummaryCompleteEvent(
        event('summary_complete', {
          fullMarkdown: '总体判断',
          json: { signal: 'NEUTRAL', confidence: 'LOW' },
        }),
      ),
      {
        event: 'summary_complete',
        data: { summaryJson: { signal: 'NEUTRAL', confidence: 'LOW' } },
      },
    );
    assert.deepEqual(mapDoneEvent('analysis-1', 'PARTIAL_FAILED'), {
      event: 'done',
      data: { analysisId: 'analysis-1', status: 'PARTIAL_FAILED' },
    });
    assert.deepEqual(
      mapErrorEvent(
        event('error', {
          sectionType: 'MARKET_SIGNALS',
          message: 'provider failed',
          recoverable: false,
        }),
      ),
      {
        event: 'error',
        data: {
          message: 'provider failed',
          failedSections: ['MARKET_SIGNALS'],
        },
      },
    );
    assert.deepEqual(mapThrownError('boom'), {
      event: 'error',
      data: { message: 'boom' },
    });
  });
});
