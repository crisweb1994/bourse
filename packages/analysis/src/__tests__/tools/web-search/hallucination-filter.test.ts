import { describe, expect, it } from 'vitest';
import { HallucinationFilter } from '../../../tools/web-search/hallucination-filter';

describe('HallucinationFilter', () => {
  it('passes through normal text unchanged', () => {
    const f = new HallucinationFilter();
    expect(f.feed('Hello world. ')).toBe('Hello world. ');
    expect(f.feed('Another line.')).toBe('Another line.');
    expect(f.flush()).toBe('');
    expect(f.suppressedBytes).toBe(0);
  });

  it('strips a single-chunk <function>…</function> block', () => {
    const f = new HallucinationFilter();
    const input =
      'before <function><invoke name="web_search"><parameter name="q">x</parameter></invoke></function> after';
    expect(f.feed(input)).toBe('before  after');
    expect(f.suppressedBytes).toBeGreaterThan(0);
  });

  it('strips block split across chunks', () => {
    const f = new HallucinationFilter();
    let out = '';
    out += f.feed('plain text <function>');
    out += f.feed('<invoke name="web_search">');
    out += f.feed('<parameter name="q" string="hello" />');
    out += f.feed('</invoke>');
    out += f.feed('</function> tail');
    out += f.flush();
    expect(out).toBe('plain text  tail');
  });

  it('strips <function_calls> Anthropic-style XML', () => {
    const f = new HallucinationFilter();
    const out =
      f.feed('A <function_calls><invoke name="web_search"/></function_calls> B') +
      f.flush();
    expect(out).toBe('A  B');
  });

  it('strips inline {thoughts: …, command: web_search …} JSON', () => {
    const f = new HallucinationFilter();
    const input =
      'preface\n{thoughts: "I need data", command: "web_search", keywords: ["a","b"]}\nrest';
    const out = f.feed(input) + f.flush();
    expect(out).toContain('preface');
    expect(out).toContain('rest');
    expect(out).not.toContain('command');
  });

  it('strips "搜索 N: web_search(...)" pseudo-plans', () => {
    const f = new HallucinationFilter();
    const input = '正文1\n搜索 1: 沪电股份 公司治理\n正文2';
    const out = f.feed(input) + f.flush();
    expect(out).toContain('正文1');
    expect(out).toContain('正文2');
    expect(out).not.toContain('搜索 1');
  });

  it('drops unterminated region rather than leak partial', () => {
    const f = new HallucinationFilter();
    f.feed('keep <function><invoke name="x">never closes...');
    const tail = f.flush();
    expect(tail).toBe('');
    expect(f.suppressedBytes).toBeGreaterThan(0);
  });

  it('does not swallow stray < that is not an opener', () => {
    const f = new HallucinationFilter();
    const out = f.feed('a < b') + f.feed(' and c < d') + f.flush();
    expect(out).toContain('a < b');
    expect(out).toContain('c < d');
  });
});
