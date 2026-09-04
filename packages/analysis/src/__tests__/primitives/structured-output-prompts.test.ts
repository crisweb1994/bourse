import { describe, expect, it } from 'vitest';
import { buildStructuredOutputPrompts } from '../../primitives/dimension-prompts';

describe('structured output prompts V2', () => {
  it('requires the current section schema and rejects unsupported claims', () => {
    const prompts = buildStructuredOutputPrompts('VALUATION_SCENARIOS', 'report', ['https://example.com']);
    expect(prompts.system).toContain('schemaVersion="analysis-section-v2"');
    expect(prompts.system).toContain('methods 和 scenarios');
    expect(prompts.system).toContain('input.evidence 每项必须是');
    expect(prompts.system).toContain('UNASSESSABLE');
    expect(prompts.user).toContain('https://example.com');
  });
});
