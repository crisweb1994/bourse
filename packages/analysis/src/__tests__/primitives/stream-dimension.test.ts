import { describe, expect, it, vi } from 'vitest';
import { SCHEMA_VERSION } from '../../contracts/analysis-result';
import type { SseEvent } from '../../contracts/sse-events';
import { getDimension } from '../../dimensions';
import type { AgentProvider } from '../../primitives/provider';
import { streamDimension } from '../../primitives/stream-dimension';

const citation = {
  title: 'Source',
  url: 'https://example.com/source',
  sourceType: 'NEWS' as const,
  retrievedAt: '2026-01-15T10:00:00.000Z',
};

function provider(): AgentProvider {
  const complete = {
    schemaVersion: SCHEMA_VERSION,
    type: 'COMPANY_QUALITY',
    assessment: 'MIXED',
    confidence: 'MEDIUM',
    summary: 'Summary',
    findings: [],
    limitations: [],
    dataAsOf: '2026-01-15',
    disclaimer: 'Model text',
  };
  return {
    name: 'fake',
    stream: vi.fn(async (_system, _user, onChunk) => {
      onChunk({ type: 'text', text: 'hello' });
      onChunk({ type: 'citation', citation });
      return { text: 'hello', citations: [citation], usage: { tokensIn: 10, tokensOut: 20 } };
    }),
    complete: vi.fn(async () => ({ text: JSON.stringify(complete), usage: { tokensIn: 3, tokensOut: 4 } })),
    getModel: () => 'model',
    getUtilityModel: () => 'utility',
  };
}

async function collect(gen: AsyncGenerator<SseEvent>): Promise<SseEvent[]> {
  const events: SseEvent[] = [];
  for await (const event of gen) events.push(event);
  return events;
}

describe('streamDimension V2', () => {
  it('emits ordered section events with validated V2 structured data', async () => {
    const events = await collect(streamDimension(
      provider(),
      getDimension('COMPANY_QUALITY'),
      { symbol: 'AAPL', market: 'US', locale: 'zh-CN' },
      { runId: 'run-1', todayDate: '2026-01-15', order: 2 },
    ));
    expect(events.map((event) => event.type)).toEqual([
      'section_start', 'report_chunk', 'citation', 'report_complete',
      'structured_data', 'section_complete',
    ]);
    expect(events.every((event) => event.runId === 'run-1')).toBe(true);
    expect(events.map((event) => event.seq)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(events[0]).toMatchObject({ sectionType: 'COMPANY_QUALITY', order: 2 });
    expect(events.find((event) => event.type === 'structured_data')).toMatchObject({
      json: { schemaVersion: SCHEMA_VERSION, type: 'COMPANY_QUALITY' },
    });
  });

  it('uses the fixed disclaimer instead of model-supplied text', async () => {
    const events = await collect(streamDimension(
      provider(), getDimension('COMPANY_QUALITY'),
      { symbol: 'AAPL', market: 'US', locale: 'zh-CN' },
      { runId: 'run-2', todayDate: '2026-01-15' },
    ));
    const structured = events.find((event) => event.type === 'structured_data');
    expect(structured).toMatchObject({
      json: { disclaimer: expect.stringContaining('不构成投资建议') },
    });
  });
});
