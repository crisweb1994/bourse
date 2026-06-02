import { describe, expect, it } from 'vitest';
import { SCHEMA_VERSION } from '../../contracts/analysis-result';
import { SseEvent } from '../../contracts/sse-events';

const baseFields = { runId: 'run_test', seq: 0 };

const validResult = {
  reportMarkdown: '',
  structuredJson: {
    schemaVersion: SCHEMA_VERSION,
    conclusion: {
      signal: 'NEUTRAL' as const,
      confidence: 'LOW' as const,
      oneLiner: 'placeholder',
      evidence: [],
    },
    evidence: [],
    dataAvailability: { missingFields: [], reason: '' },
    dataAsOf: '2026-01-15',
    disclaimer: 'd',
  },
  citations: [],
  status: 'COMPLETED' as const,
  signal: 'NEUTRAL' as const,
  confidence: 'LOW' as const,
  trace: {
    llmCalls: 0,
    toolCalls: 0,
    tokensIn: 0,
    tokensOut: 0,
    totalUsd: 0,
    durationMs: 0,
  },
  warnings: [],
};

describe('contracts/SseEvent — discriminated union', () => {
  it('parses section_start', () => {
    const evt = {
      ...baseFields,
      type: 'section_start' as const,
      sectionType: 'FUNDAMENTAL' as const,
      order: 0,
    };
    expect(SseEvent.parse(evt).type).toBe('section_start');
  });

  it('parses report_chunk', () => {
    const evt = {
      ...baseFields,
      type: 'report_chunk' as const,
      sectionType: 'TECHNICAL' as const,
      deltaText: 'partial markdown',
    };
    expect(SseEvent.parse(evt)).toMatchObject({ type: 'report_chunk' });
  });

  it('parses cost_update', () => {
    const evt = {
      ...baseFields,
      type: 'cost_update' as const,
      totalUsd: 0.123,
      totalTokens: 1000,
      toolCalls: 5,
    };
    expect(SseEvent.parse(evt)).toMatchObject({ type: 'cost_update' });
  });

  it('parses done with full AnalysisResult', () => {
    const evt = {
      ...baseFields,
      type: 'done' as const,
      status: 'COMPLETED' as const,
      result: validResult,
    };
    const parsed = SseEvent.parse(evt);
    expect(parsed.type).toBe('done');
    if (parsed.type === 'done') {
      expect(parsed.result?.status).toBe('COMPLETED');
    }
  });

  it('parses error with optional sectionType', () => {
    const evt = {
      ...baseFields,
      type: 'error' as const,
      message: 'something failed',
      recoverable: false,
    };
    expect(SseEvent.parse(evt)).toMatchObject({ recoverable: false });
  });

  it('rejects unknown event type', () => {
    expect(() =>
      SseEvent.parse({ ...baseFields, type: 'mystery_event' }),
    ).toThrow();
  });

  it('requires runId + seq on every event', () => {
    expect(() =>
      SseEvent.parse({
        type: 'section_start',
        sectionType: 'FUNDAMENTAL',
        order: 0,
      }),
    ).toThrow();
  });

  it('rejects negative seq', () => {
    expect(() =>
      SseEvent.parse({
        ...baseFields,
        seq: -1,
        type: 'section_start',
        sectionType: 'FUNDAMENTAL',
        order: 0,
      }),
    ).toThrow();
  });
});
