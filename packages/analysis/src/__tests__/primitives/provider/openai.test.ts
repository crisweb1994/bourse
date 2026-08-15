import { describe, expect, it } from 'vitest';
import { extractUrlsFromText, OpenAIProvider } from '../../../primitives/provider/openai';
import type { WebSearchExecutor } from '../../../tools/web-search/executor';

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

describe('OpenAIProvider — web-search executor lifecycle', () => {
  it('memoizes the executor across factory calls (per-run, not per-stream)', () => {
    // Regression: previously the factory was invoked fresh on every provider
    // stream, so every module / structured-output pass got its own executor
    // and its own maxSearchesPerRun budget — one analysis could burn
    // `cap × (modules × rounds + summary)` searches. The provider now
    // memoizes the executor for its own lifetime (one provider == one run).
    let invocations = 0;
    const sentinel = {} as unknown as WebSearchExecutor;
    const provider = new OpenAIProvider({
      apiKey: 'k',
      webSearchExecutorFactory: () => {
        invocations += 1;
        return sentinel;
      },
    });
    // Reach into the private factory via the same path chat-completions-route
    // uses — three simulated streams should all see the SAME executor.
    // The factory field is private; cast to access it.
    const factory = (
      provider as unknown as {
        webSearchExecutorFactory: () => WebSearchExecutor | null;
      }
    ).webSearchExecutorFactory;
    const a = factory();
    const b = factory();
    const c = factory();
    expect(a).toBe(sentinel);
    expect(b).toBe(sentinel);
    expect(c).toBe(sentinel);
    expect(invocations).toBe(1);
  });
});
