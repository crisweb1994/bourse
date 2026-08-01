import { describe, expect, it } from 'vitest';
import { buildStructuredOutputPrompts } from '../../primitives/dimension-prompts';

describe('buildStructuredOutputPrompts data availability', () => {
  it('limits missing fields to facts required for the current conclusion', () => {
    const prompts = buildStructuredOutputPrompts(
      'FUNDAMENTAL',
      'The report has sufficient verified facts.',
      [],
    );

    expect(prompts.system).toContain(
      '本维度形成当前结论所必需、且报告明确无法取得',
    );
    expect(prompts.system).toContain(
      '已有足够证据支持当前结论时，missingFields 必须填 []',
    );
    expect(prompts.system).toContain(
      'missingCriticalFacts 必须保留',
    );
  });
});
