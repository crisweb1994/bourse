import { describe, expect, it } from 'vitest';
import { sectionizeFilingText, selectRelevantFilingSections } from '../earnings-sections';

describe('filing section retrieval', () => {
  const text = [
    'Cover page',
    'ITEM 2. MANAGEMENT’S DISCUSSION AND ANALYSIS',
    'Revenue grew because services demand increased.',
    'Liquidity and Capital Resources',
    'Operating cash flow was 100 and capital expenditure was 20.',
    'Risk Factors',
    'Currency volatility remains a material risk.',
  ].join('\n');

  it('creates stable offset-bound sections for long filings', () => {
    const sections = sectionizeFilingText(text);
    expect(sections.length).toBeGreaterThanOrEqual(3);
    expect(sections.every((section) => text.slice(section.startOffset, section.endOffset).trim() === section.text)).toBe(true);
  });

  it('selects cash-flow sections without a vector database', () => {
    const selected = selectRelevantFilingSections(sectionizeFilingText(text), '现金流和资本开支有什么变化？', 1);
    expect(selected[0]?.title).toMatch(/Liquidity/i);
    expect(selected[0]?.text).toContain('Operating cash flow');
  });
});
