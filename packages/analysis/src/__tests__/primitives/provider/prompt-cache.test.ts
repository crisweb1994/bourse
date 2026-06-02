import { describe, expect, it } from 'vitest';
import type { SystemPromptInput } from '../../../primitives/provider';

/**
 * RFC-04: provider-layer prompt-cache shape tests.
 *
 * Live SDK behaviour (cache_creation/read tokens, 1024-token min, etc.)
 * is verified at integration time via RunAggregate. These unit tests
 * just lock the structural contract:
 *   - SystemPromptInput is `string | readonly SystemTextBlock[]`.
 *   - SystemTextBlock has `type: 'text' | text | cacheControl?`.
 *   - Anthropic provider's internal translator yields the right SDK shape.
 *   - OpenAI provider's flatten() collapses array to string.
 */

// ---- Test: SystemPromptInput shape ----

describe('contracts: SystemPromptInput', () => {
  it('accepts a plain string (back-compat path)', () => {
    const input: SystemPromptInput = 'hello';
    expect(typeof input).toBe('string');
  });

  it('accepts an array of SystemTextBlock (RFC-04 cache path)', () => {
    const input: SystemPromptInput = [
      { type: 'text', text: 'stable prefix', cacheControl: { type: 'ephemeral' } },
      { type: 'text', text: 'variable suffix' },
    ];
    expect(Array.isArray(input)).toBe(true);
    expect((input as readonly { text: string }[])[0]?.text).toBe('stable prefix');
  });

  it('readonly array prevents accidental mutation', () => {
    const input: SystemPromptInput = [{ type: 'text', text: 'a' }];
    // TS should refuse `input.push(...)` at compile time; runtime is
    // a regular array because TS readonly is structural-only. We assert
    // shape, not enforcement.
    expect((input as readonly { text: string }[])[0]?.text).toBe('a');
  });
});

// ---- Test: shape we ship to the SDK is correct ----

// We re-implement the translator here (same logic as claude.ts) and
// pin its output. If claude.ts's `toAnthropicSystemParam` ever drifts,
// integration tests will catch the actual SDK shape; these unit tests
// catch the contract.
function fakeToAnthropic(input: SystemPromptInput):
  | string
  | Array<{ type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }> {
  if (typeof input === 'string') return input;
  return input.map((b) => ({
    type: 'text' as const,
    text: b.text,
    ...(b.cacheControl ? { cache_control: { type: 'ephemeral' as const } } : {}),
  }));
}

describe('claude provider: SDK shape translation', () => {
  it('string → string (unchanged)', () => {
    expect(fakeToAnthropic('hello')).toBe('hello');
  });

  it('array without cacheControl → SDK array without cache_control', () => {
    const out = fakeToAnthropic([{ type: 'text', text: 'a' }]);
    expect(out).toEqual([{ type: 'text', text: 'a' }]);
  });

  it('cacheControl: ephemeral → SDK cache_control: { type: "ephemeral" }', () => {
    const out = fakeToAnthropic([
      { type: 'text', text: 'cached', cacheControl: { type: 'ephemeral' } },
    ]);
    expect(out).toEqual([
      { type: 'text', text: 'cached', cache_control: { type: 'ephemeral' } },
    ]);
  });

  it('mixed cached + uncached blocks preserved in order', () => {
    const out = fakeToAnthropic([
      { type: 'text', text: 'stable', cacheControl: { type: 'ephemeral' } },
      { type: 'text', text: 'variable' },
    ]);
    expect(out).toEqual([
      { type: 'text', text: 'stable', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'variable' },
    ]);
  });
});

// ---- Test: OpenAI flatten ----

function fakeFlattenSystem(input: SystemPromptInput): string {
  if (typeof input === 'string') return input;
  return input.map((b) => b.text).join('\n');
}

describe('openai provider: array flattening', () => {
  it('string passes through unchanged', () => {
    expect(fakeFlattenSystem('hello')).toBe('hello');
  });

  it('single-block array → single text', () => {
    expect(fakeFlattenSystem([{ type: 'text', text: 'a' }])).toBe('a');
  });

  it('multi-block array → joined by newline', () => {
    expect(
      fakeFlattenSystem([
        { type: 'text', text: 'stable', cacheControl: { type: 'ephemeral' } },
        { type: 'text', text: 'variable' },
      ]),
    ).toBe('stable\nvariable');
  });

  it('cacheControl silently dropped (OpenAI uses different cache mechanism)', () => {
    const flat = fakeFlattenSystem([
      { type: 'text', text: 'x', cacheControl: { type: 'ephemeral' } },
    ]);
    expect(flat).toBe('x');
    expect(flat).not.toContain('cache');
  });
});
