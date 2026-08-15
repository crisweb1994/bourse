import assert from 'node:assert/strict';
import { applyAnalysisStreamEvent, INITIAL_ANALYSIS_STREAM_STATE, isAnalysisStreamEventName, startStreamState } from './analysis-stream-state';

assert.equal(isAnalysisStreamEventName('section_start'), true);
assert.equal(isAnalysisStreamEventName('judge_start'), false);
let state = startStreamState(INITIAL_ANALYSIS_STREAM_STATE, 'analysis-1');
state = applyAnalysisStreamEvent(state, 'section_start', { sectionType: 'COMPANY_QUALITY', sectionId: 'section-1', order: 0 });
state = applyAnalysisStreamEvent(state, 'report_chunk', { sectionType: 'COMPANY_QUALITY', text: 'hello' });
state = applyAnalysisStreamEvent(state, 'structured_data', { sectionType: 'COMPANY_QUALITY', json: { assessment: 'STRONG' } });
state = applyAnalysisStreamEvent(state, 'section_complete', { sectionType: 'COMPANY_QUALITY', status: 'COMPLETED' });
assert.equal(state.sections.COMPANY_QUALITY?.markdown, 'hello');
assert.equal(state.sections.COMPANY_QUALITY?.status, 'completed');
assert.equal(state.sections.COMPANY_QUALITY?.structuredJson.assessment, 'STRONG');
state = applyAnalysisStreamEvent(state, 'report_complete', {
  sectionType: 'COMPANY_QUALITY',
  text: 'clean final report',
});
assert.equal(state.sections.COMPANY_QUALITY?.markdown, 'clean final report');
state = applyAnalysisStreamEvent(state, 'section_start', { sectionType: 'MARKET_SIGNALS', sectionId: 'section-2', order: 4 });
state = applyAnalysisStreamEvent(state, 'report_chunk', { sectionType: 'MARKET_SIGNALS', text: '{"legacy":true}' });
state = applyAnalysisStreamEvent(state, 'citation', { sectionType: 'MARKET_SIGNALS', title: 'Source', url: 'https://example.com/source', claim: 'claim' });
state = applyAnalysisStreamEvent(state, 'error', { sectionType: 'MARKET_SIGNALS', message: '结构化结果不符合格式' });
state = applyAnalysisStreamEvent(state, 'section_complete', { sectionType: 'MARKET_SIGNALS', status: 'FAILED', error: '结构化结果不符合格式' });
assert.equal(state.sections.MARKET_SIGNALS?.status, 'failed');
assert.equal(state.sections.MARKET_SIGNALS?.markdown, '');
assert.equal(state.sections.MARKET_SIGNALS?.structuredJson, null);
assert.deepEqual(state.sections.MARKET_SIGNALS?.citations, []);
assert.equal(state.sections.MARKET_SIGNALS?.errorMessage, '结构化结果不符合格式');
state = applyAnalysisStreamEvent(state, 'summary_complete', { summaryJson: { headline: '测试', signal: null, confidence: 'LOW' } });
assert.equal(state.summaryJson.headline, '测试');
state = applyAnalysisStreamEvent(state, 'done', { analysisId: 'analysis-1', status: 'CANCELLED' });
assert.equal(state.status, 'cancelled');
assert.equal(state.error, null);
console.log('analysis-stream-state assertions passed');
