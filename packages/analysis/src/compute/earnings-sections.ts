import { computeContentHash } from '../util/content-hash';

export interface FilingSection {
  id: string;
  title: string;
  text: string;
  startOffset: number;
  endOffset: number;
  pageStart?: number;
  pageEnd?: number;
}

const HEADING_PATTERNS = [
  /^item\s+\d+[a-z]?\.?\s+/i,
  /^management['’]s discussion and analysis/i,
  /^results of operations/i,
  /^liquidity and capital resources/i,
  /^risk factors/i,
  /^财务报表(?:附注)?$/,
  /^管理层讨论与分析$/,
  /^经营情况讨论与分析$/,
  /^主要会计数据和财务指标$/,
  /^重要事项$/,
  /^公司未来发展的展望$/,
];

export function sectionizeFilingText(
  text: string,
  pages?: Array<{ page: number; startOffset: number; endOffset: number }>,
): FilingSection[] {
  if (!text.trim()) return [];
  const headings: Array<{ title: string; startOffset: number }> = [];
  let offset = 0;
  for (const line of text.split('\n')) {
    const title = line.trim().replace(/\s+/g, ' ');
    if (title.length >= 3 && title.length <= 140 && HEADING_PATTERNS.some((pattern) => pattern.test(title))) {
      headings.push({ title, startOffset: offset + line.indexOf(line.trim()) });
    }
    offset += line.length + 1;
  }
  if (headings.length === 0) return chunkFallback(text, pages);
  const boundaries = headings[0].startOffset > 0
    ? [{ title: '报告摘要', startOffset: 0 }, ...headings]
    : headings;
  return boundaries.flatMap((heading, index) => {
    const endOffset = boundaries[index + 1]?.startOffset ?? text.length;
    const sectionText = text.slice(heading.startOffset, endOffset).trim();
    if (!sectionText) return [];
    return [buildSection(heading.title, sectionText, heading.startOffset, endOffset, pages)];
  });
}

export function selectRelevantFilingSections(
  sections: FilingSection[],
  question: string,
  limit = 4,
): FilingSection[] {
  const terms = tokenize(question);
  return sections
    .map((section, index) => ({
      section,
      index,
      score: terms.reduce((score, term) => {
        const titleHits = occurrences(section.title.toLowerCase(), term);
        const bodyHits = occurrences(section.text.toLowerCase().slice(0, 12_000), term);
        return score + titleHits * 6 + Math.min(bodyHits, 5);
      }, 0),
    }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, limit)
    .map(({ section }) => section);
}

function chunkFallback(
  text: string,
  pages?: Array<{ page: number; startOffset: number; endOffset: number }>,
): FilingSection[] {
  const maxChars = 12_000;
  const sections: FilingSection[] = [];
  for (let start = 0; start < text.length; start += maxChars) {
    const end = Math.min(text.length, start + maxChars);
    sections.push(buildSection(`报告正文 ${sections.length + 1}`, text.slice(start, end), start, end, pages));
  }
  return sections;
}

function buildSection(
  title: string,
  text: string,
  startOffset: number,
  endOffset: number,
  pages?: Array<{ page: number; startOffset: number; endOffset: number }>,
): FilingSection {
  const overlaps = pages?.filter((page) => page.endOffset > startOffset && page.startOffset < endOffset) ?? [];
  return {
    id: computeContentHash({ text: `${title}:${startOffset}:${endOffset}:${text}` }),
    title,
    text,
    startOffset,
    endOffset,
    ...(overlaps[0] ? { pageStart: overlaps[0].page } : {}),
    ...(overlaps.at(-1) ? { pageEnd: overlaps.at(-1)!.page } : {}),
  };
}

function tokenize(question: string): string[] {
  const normalized = question.toLowerCase();
  const synonymGroups = [
    ['营收', '收入', 'revenue', 'sales'],
    ['利润', 'profit', 'income'],
    ['现金流', 'cash flow', 'cash flows'],
    ['资本开支', '资本支出', 'capex', 'capital expenditure'],
    ['毛利率', '利润率', 'margin', 'margins'],
    ['风险', 'risk', 'risks'],
    ['指引', '业绩指引', 'guidance', 'outlook'],
    ['流动性', 'liquidity'],
    ['债务', 'debt', 'borrowings'],
    ['业务', '经营', 'operations'],
    ['管理层', 'management'],
  ];
  const matched = synonymGroups.flatMap((group) => (
    group.some((term) => normalized.includes(term)) ? group : []
  ));
  const ascii = normalized.match(/[a-z][a-z0-9-]{2,}/g) ?? [];
  return [...new Set([...matched, ...ascii])];
}

function occurrences(text: string, term: string): number {
  if (!term) return 0;
  let count = 0;
  let cursor = 0;
  while ((cursor = text.indexOf(term, cursor)) >= 0) {
    count += 1;
    cursor += term.length;
  }
  return count;
}
