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
state = applyAnalysisStreamEvent(state, 'summary_complete', { summaryJson: { headline: '测试', signal: null, confidence: 'LOW' } });
assert.equal(state.summaryJson.headline, '测试');
state = applyAnalysisStreamEvent(state, 'done', { analysisId: 'analysis-1', status: 'CANCELLED' });
assert.equal(state.status, 'cancelled');
assert.equal(state.error, null);
console.log('analysis-stream-state assertions passed');
