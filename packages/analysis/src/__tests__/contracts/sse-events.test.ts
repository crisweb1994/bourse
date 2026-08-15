import { describe, expect, it } from 'vitest';
import { SseEvent } from '../../contracts/sse-events';

const base = { runId: 'run-1', seq: 1 };

describe('SseEvent V2', () => {
  it('parses section progress, skip and done events', () => {
    expect(SseEvent.parse({
      ...base, type: 'section_start', sectionType: 'COMPANY_QUALITY', order: 0,
    }).type).toBe('section_start');
    expect(SseEvent.parse({
      ...base, type: 'section_skipped', sectionType: 'VALUATION_SCENARIOS',
      reason: 'INSUFFICIENT_REQUIRED_FACTS', missingFields: ['financials'],
    }).type).toBe('section_skipped');
    expect(SseEvent.parse({
      ...base, type: 'done', status: 'FAILED', result: {
        reportMarkdown: '', structuredJson: null, citations: [], status: 'FAILED',
        confidence: 'LOW', trace: { llmCalls: 0, toolCalls: 0, tokensIn: 0, tokensOut: 0, durationMs: 0 },
        warnings: ['failed'],
      },
    }).type).toBe('done');
  });

  it('rejects old section and budget statuses', () => {
    expect(() => SseEvent.parse({
      ...base, type: 'section_start', sectionType: 'FUNDAMENTAL', order: 0,
    })).toThrow();
    expect(() => SseEvent.parse({
      ...base, type: 'section_complete', sectionType: 'COMPANY_QUALITY', status: 'BUDGET_EXHAUSTED',
    })).toThrow();
  });
});
