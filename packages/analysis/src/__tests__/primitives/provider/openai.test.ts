import { describe, expect, it } from 'vitest';
import { extractUrlsFromText } from '../../../primitives/provider/openai';

describe('openai/extractUrlsFromText', () => {
  it('returns empty for text with no URLs', () => {
    expect(extractUrlsFromText('hello world, no links here.')).toEqual([]);
  });

  it('extracts markdown links with title preserved', () => {
    const text = '请参考 [2026Q1 财报](https://static.cninfo.com.cn/finalpage/2026-04-23/1225147393.PDF) 中的披露。';
    const got = extractUrlsFromText(text);
    expect(got).toEqual([
      {
        title: '2026Q1 财报',
        url: 'https://static.cninfo.com.cn/finalpage/2026-04-23/1225147393.PDF',
      },
    ]);
  });

  it('extracts bare URLs with no title', () => {
    const text = 'See https://example.com/foo and also https://example.com/bar';
    const got = extractUrlsFromText(text);
    expect(got).toEqual([
      { url: 'https://example.com/foo' },
      { url: 'https://example.com/bar' },
    ]);
  });

  it('strips trailing sentence punctuation from bare URLs', () => {
    const text = 'See https://example.com/path.';
    expect(extractUrlsFromText(text)).toEqual([
      { url: 'https://example.com/path' },
    ]);
  });

  it('dedupes same URL across markdown link and bare appearance', () => {
    const text = '[a](https://example.com/x) and bare https://example.com/x too';
    const got = extractUrlsFromText(text);
    expect(got).toHaveLength(1);
    expect(got[0]).toEqual({ title: 'a', url: 'https://example.com/x' });
  });

  it('handles mixed markdown + bare URLs together', () => {
    const text = [
      '## 引用',
      '- [财报](https://static.cninfo.com.cn/finalpage/2026-04-23/x.PDF)',
      '- 公司公告: https://www.szse.cn/disclosure/listed/notice/y.html',
    ].join('\n');
    const got = extractUrlsFromText(text);
    expect(got).toEqual([
      {
        title: '财报',
        url: 'https://static.cninfo.com.cn/finalpage/2026-04-23/x.PDF',
      },
      {
        url: 'https://www.szse.cn/disclosure/listed/notice/y.html',
      },
    ]);
  });

  it('ignores trailing closing parens not part of url even when not in markdown link', () => {
    const text = 'see also (https://example.com/page)';
    expect(extractUrlsFromText(text)).toEqual([
      { url: 'https://example.com/page' },
    ]);
  });
});
