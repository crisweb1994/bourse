import assert from 'node:assert/strict';
import {
  applyAnalysisStreamEvent,
  INITIAL_ANALYSIS_STREAM_STATE,
  isAlreadyRunningStreamError,
  markAttachedElsewhere,
  markStreamConnectionError,
  startStreamState,
  stopWatchingStreamState,
} from './analysis-stream-state';

let state = startStreamState(INITIAL_ANALYSIS_STREAM_STATE, 'analysis-1');
state = applyAnalysisStreamEvent(state, 'section_start', {
  sectionType: 'FUNDAMENTAL',
  sectionId: 'section-1',
  order: 0,
});
state = applyAnalysisStreamEvent(state, 'report_chunk', {
  sectionType: 'FUNDAMENTAL',
  text: 'hello ',
});
state = applyAnalysisStreamEvent(state, 'report_chunk', {
  text: 'world',
});
state = applyAnalysisStreamEvent(state, 'structured_data', {
  sectionType: 'FUNDAMENTAL',
  json: { conclusion: { signal: 'BULLISH' } },
});
state = applyAnalysisStreamEvent(state, 'citation', {
  sectionType: 'FUNDAMENTAL',
  title: '10-K',
  url: 'https://example.com',
  claim: '',
  searchAdapter: 'native',
});
state = applyAnalysisStreamEvent(state, 'section_complete', {
  sectionType: 'FUNDAMENTAL',
  status: 'COMPLETED',
});

assert.equal(state.sections.FUNDAMENTAL?.markdown, 'hello world');
assert.equal(state.sections.FUNDAMENTAL?.status, 'completed');
assert.deepEqual(state.sections.FUNDAMENTAL?.structuredJson, {
  conclusion: { signal: 'BULLISH' },
});
assert.equal(state.sections.FUNDAMENTAL?.citations[0]?.searchAdapter, 'native');

const beforeInvalidSection = state;
state = applyAnalysisStreamEvent(state, 'section_start', {
  sectionType: 'COMPREHENSIVE',
  sectionId: 'section-summary',
  order: 99,
});
assert.equal(state, beforeInvalidSection);
assert.equal('COMPREHENSIVE' in state.sections, false);

state = applyAnalysisStreamEvent(state, 'report_chunk', {
  sectionType: 'NOT_A_SECTION',
  text: 'ignored',
});
assert.equal(state, beforeInvalidSection);

state = applyAnalysisStreamEvent(state, 'evidence_pack_ready', {
  pack: {
    dataAvailability: {
      degradedSource: 'WEB_SEARCH_FALLBACK',
      fallbackReason: {
        kind: 'NETWORK',
        failedTools: ['quote'],
        message: 'quote unavailable',
      },
    },
  },
});
assert.deepEqual(state.degraded, {
  kind: 'NETWORK',
  failedTools: ['quote'],
  message: 'quote unavailable',
});

state = applyAnalysisStreamEvent(state, 'summary_chunk', { text: 'overall' });
state = applyAnalysisStreamEvent(state, 'summary_complete', {
  summaryJson: { overallSignal: 'BULLISH' },
});
assert.equal(state.summaryMarkdown, 'overall');
assert.deepEqual(state.summaryJson, { overallSignal: 'BULLISH' });

state = applyAnalysisStreamEvent(state, 'done', {
  analysisId: 'analysis-1',
  status: 'BUDGET_EXHAUSTED',
});
assert.equal(state.status, 'error');
assert.equal(state.error, 'Run ended in BUDGET_EXHAUSTED');
assert.equal(state.attachedElsewhere, false);

let attached = markAttachedElsewhere(
  startStreamState(INITIAL_ANALYSIS_STREAM_STATE, 'analysis-2'),
);
assert.equal(attached.attachedElsewhere, true);
assert.equal(isAlreadyRunningStreamError('Analysis is already running'), true);
assert.equal(
  markStreamConnectionError(attached, 'network').status,
  'streaming',
);

attached = startStreamState(attached, 'analysis-2');
assert.equal(attached.attachedElsewhere, true);
assert.equal(stopWatchingStreamState(attached).status, 'completed');

console.log('analysis-stream-state assertions passed');
