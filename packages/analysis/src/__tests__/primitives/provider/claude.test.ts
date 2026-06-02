import type Anthropic from '@anthropic-ai/sdk';
import type {
  Message,
  RawMessageStreamEvent,
} from '@anthropic-ai/sdk/resources/messages/messages';
import { describe, expect, it, vi } from 'vitest';
import { ClaudeProvider } from '../../../primitives/provider/claude';
import type { ProviderStreamChunk } from '../../../primitives/provider/types';

// ===== Fake Anthropic client helpers =====

function buildUsage(input: number, output: number): Message['usage'] {
  return {
    input_tokens: input,
    output_tokens: output,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    server_tool_use: null,
    service_tier: null,
    cache_creation: null,
    inference_geo: null,
  };
}

function buildMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-4-20250514',
    content: [],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: buildUsage(0, 0),
    ...overrides,
  } as Message;
}

function buildStreamMock(
  events: RawMessageStreamEvent[],
  finalMessage: Message,
) {
  const asyncIter = (async function* () {
    for (const ev of events) yield ev;
  })();
  return Object.assign(asyncIter, {
    finalMessage: vi.fn(() => Promise.resolve(finalMessage)),
  });
}

function buildFakeClient(opts: {
  streamEvents?: RawMessageStreamEvent[];
  streamFinal?: Message;
  completeMessage?: Message;
  onStreamCalled?: (params: unknown, options: unknown) => void;
  onCreateCalled?: (params: unknown, options: unknown) => void;
}): Anthropic {
  const stream = vi.fn((params: unknown, options: unknown) => {
    opts.onStreamCalled?.(params, options);
    return buildStreamMock(opts.streamEvents ?? [], opts.streamFinal ?? buildMessage());
  });
  const create = vi.fn(async (params: unknown, options: unknown) => {
    opts.onCreateCalled?.(params, options);
    return opts.completeMessage ?? buildMessage();
  });
  return { messages: { stream, create } } as unknown as Anthropic;
}

const textDelta = (text: string): RawMessageStreamEvent =>
  ({
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text },
  }) as RawMessageStreamEvent;

const citationDelta = (
  url: string,
  title: string | null,
): RawMessageStreamEvent =>
  ({
    type: 'content_block_delta',
    index: 0,
    delta: {
      type: 'citations_delta',
      citation: {
        type: 'web_search_result_location',
        cited_text: 'placeholder snippet',
        encrypted_index: 'enc_idx',
        url,
        title,
      },
    },
  }) as RawMessageStreamEvent;

// ===== Tests =====

describe('ClaudeProvider.stream', () => {
  it('accumulates text deltas in arrival order', async () => {
    const provider = new ClaudeProvider({
      apiKey: 'k',
      _internalClient: buildFakeClient({
        streamEvents: [textDelta('Hello '), textDelta('world')],
        streamFinal: buildMessage(),
      }),
    });

    const chunks: ProviderStreamChunk[] = [];
    const result = await provider.stream('sys', 'user', (c) => chunks.push(c));

    expect(result.text).toBe('Hello world');
    expect(chunks).toEqual([
      { type: 'text', text: 'Hello ' },
      { type: 'text', text: 'world' },
    ]);
  });

  it('maps citations_delta into our Citation shape with defaults', async () => {
    const provider = new ClaudeProvider({
      apiKey: 'k',
      _internalClient: buildFakeClient({
        streamEvents: [
          textDelta('See: '),
          citationDelta('https://example.com/a', 'Source A'),
        ],
        streamFinal: buildMessage(),
      }),
    });

    const chunks: ProviderStreamChunk[] = [];
    const result = await provider.stream('sys', 'user', (c) => chunks.push(c));

    expect(result.citations).toHaveLength(1);
    const c = result.citations[0]!;
    expect(c.url).toBe('https://example.com/a');
    expect(c.title).toBe('Source A');
    expect(c.sourceType).toBe('OTHER');
    expect(typeof c.retrievedAt).toBe('string');
    expect(() => new Date(c.retrievedAt).toISOString()).not.toThrow();
  });

  it('falls back to url as title when citation title is null', async () => {
    const provider = new ClaudeProvider({
      apiKey: 'k',
      _internalClient: buildFakeClient({
        streamEvents: [citationDelta('https://example.com/no-title', null)],
        streamFinal: buildMessage(),
      }),
    });
    const result = await provider.stream('sys', 'user', () => {});
    expect(result.citations[0]!.title).toBe('https://example.com/no-title');
  });

  it('deduplicates citations across delta + final-message tool blocks', async () => {
    const sharedUrl = 'https://example.com/shared';
    const finalWithToolBlock = buildMessage({
      content: [
        {
          type: 'web_search_tool_result',
          tool_use_id: 'srvtoolu_test',
          content: [
            {
              type: 'web_search_result',
              encrypted_content: 'enc',
              page_age: null,
              title: 'Shared Source',
              url: sharedUrl,
            },
            {
              type: 'web_search_result',
              encrypted_content: 'enc2',
              page_age: null,
              title: 'Unique Source',
              url: 'https://example.com/unique',
            },
          ],
        },
      ] as Message['content'],
    });

    const provider = new ClaudeProvider({
      apiKey: 'k',
      _internalClient: buildFakeClient({
        streamEvents: [citationDelta(sharedUrl, 'Shared Source')],
        streamFinal: finalWithToolBlock,
      }),
    });

    const result = await provider.stream('sys', 'user', () => {});
    expect(result.citations.map((c) => c.url)).toEqual([
      sharedUrl,
      'https://example.com/unique',
    ]);
  });

  it('counts server_tool_use(web_search) blocks into toolUseCounts.webSearch', async () => {
    const finalWithToolUses = buildMessage({
      content: [
        { type: 'server_tool_use', id: 'srv1', name: 'web_search', input: { query: 'q1' } },
        { type: 'server_tool_use', id: 'srv2', name: 'web_search', input: { query: 'q2' } },
        { type: 'server_tool_use', id: 'srv3', name: 'web_search', input: { query: 'q3' } },
      ] as Message['content'],
    });
    const provider = new ClaudeProvider({
      apiKey: 'k',
      _internalClient: buildFakeClient({ streamFinal: finalWithToolUses }),
    });
    const result = await provider.stream('sys', 'user', () => {});
    expect(result.toolUseCounts).toEqual({ webSearch: 3 });
  });

  it('returns empty toolUseCounts when no server_tool_use blocks', async () => {
    const provider = new ClaudeProvider({
      apiKey: 'k',
      _internalClient: buildFakeClient({}),
    });
    const result = await provider.stream('sys', 'user', () => {});
    expect(result.toolUseCounts).toEqual({});
  });

  it('extracts usage from finalMessage', async () => {
    const provider = new ClaudeProvider({
      apiKey: 'k',
      _internalClient: buildFakeClient({
        streamFinal: buildMessage({ usage: buildUsage(1234, 567) }),
      }),
    });
    const result = await provider.stream('sys', 'user', () => {});
    expect(result.usage).toEqual({ tokensIn: 1234, tokensOut: 567 });
  });

  it('passes signal + maxToolUses through to SDK call', async () => {
    let capturedParams: Record<string, unknown> | null = null;
    let capturedOptions: Record<string, unknown> | null = null;
    const controller = new AbortController();

    const provider = new ClaudeProvider({
      apiKey: 'k',
      _internalClient: buildFakeClient({
        onStreamCalled: (p, o) => {
          capturedParams = p as Record<string, unknown>;
          capturedOptions = o as Record<string, unknown>;
        },
      }),
    });
    await provider.stream('sys', 'user', () => {}, {
      signal: controller.signal,
      maxToolUses: 3,
    });

    const tools = capturedParams!.tools as Array<{ max_uses: number }>;
    expect(tools[0]!.max_uses).toBe(3);
    expect(capturedOptions!.signal).toBe(controller.signal);
  });
});

describe('ClaudeProvider.complete', () => {
  it('concatenates text content blocks only', async () => {
    const provider = new ClaudeProvider({
      apiKey: 'k',
      _internalClient: buildFakeClient({
        completeMessage: buildMessage({
          content: [
            { type: 'text', text: 'foo', citations: null },
            { type: 'text', text: 'bar', citations: null },
          ] as Message['content'],
          usage: buildUsage(10, 5),
        }),
      }),
    });

    const result = await provider.complete('sys', 'user');
    expect(result.text).toBe('foobar');
    expect(result.usage).toEqual({ tokensIn: 10, tokensOut: 5 });
  });

  it('uses utilityModel by default', async () => {
    let capturedModel: string | undefined;
    const provider = new ClaudeProvider({
      apiKey: 'k',
      utilityModel: 'claude-haiku-test',
      _internalClient: buildFakeClient({
        onCreateCalled: (p) => {
          capturedModel = (p as { model: string }).model;
        },
      }),
    });
    await provider.complete('sys', 'user');
    expect(capturedModel).toBe('claude-haiku-test');
  });
});

// ===== RFC-01 telemetry tests =====
//
// These exercise cache + webSearch telemetry surfaces. Anthropic returns
// cache_read/creation tokens inside usage and server_tool_use.web_search_requests
// also inside usage; web_search errors land in finalMessage.content as a
// web_search_tool_result block with content.type === 'web_search_tool_result_error'.

function buildUsageWithTelemetry(opts: {
  input: number;
  output: number;
  cacheRead?: number;
  cacheCreate?: number;
  webSearchRequests?: number;
}): Message['usage'] {
  return {
    input_tokens: opts.input,
    output_tokens: opts.output,
    cache_read_input_tokens: opts.cacheRead ?? 0,
    cache_creation_input_tokens: opts.cacheCreate ?? 0,
    server_tool_use:
      typeof opts.webSearchRequests === 'number'
        ? { web_search_requests: opts.webSearchRequests }
        : null,
    service_tier: null,
    cache_creation: null,
    inference_geo: null,
  } as Message['usage'];
}

describe('ClaudeProvider RFC-01 telemetry', () => {
  it('stream() surfaces cache + webSearchRequests from finalMessage.usage', async () => {
    const provider = new ClaudeProvider({
      apiKey: 'k',
      _internalClient: buildFakeClient({
        streamFinal: buildMessage({
          usage: buildUsageWithTelemetry({
            input: 100,
            output: 50,
            cacheRead: 42,
            cacheCreate: 7,
            webSearchRequests: 3,
          }),
        }),
      }),
    });
    const result = await provider.stream('sys', 'user', () => {});
    expect(result.usage).toEqual({
      tokensIn: 100,
      tokensOut: 50,
      cacheReadInputTokens: 42,
      cacheCreationInputTokens: 7,
      webSearchRequests: 3,
    });
  });

  it('stream() omits zero cache + webSearch fields to keep payload lean', async () => {
    const provider = new ClaudeProvider({
      apiKey: 'k',
      _internalClient: buildFakeClient({
        streamFinal: buildMessage({
          usage: buildUsageWithTelemetry({ input: 10, output: 5 }),
        }),
      }),
    });
    const result = await provider.stream('sys', 'user', () => {});
    expect(result.usage).toEqual({ tokensIn: 10, tokensOut: 5 });
    expect(result.webSearchErrors).toBeUndefined();
  });

  it('stream() accumulates web_search_tool_result_error and tags round', async () => {
    const finalMessage = buildMessage({
      content: [
        {
          type: 'web_search_tool_result',
          tool_use_id: 'srvtoolu_err',
          content: {
            type: 'web_search_tool_result_error',
            error_code: 'too_many_requests',
          },
        },
      ] as unknown as Message['content'],
      usage: buildUsageWithTelemetry({ input: 1, output: 1 }),
    });
    const provider = new ClaudeProvider({
      apiKey: 'k',
      _internalClient: buildFakeClient({ streamFinal: finalMessage }),
    });
    const result = await provider.stream('sys', 'user', () => {});
    expect(result.webSearchErrors).toHaveLength(1);
    expect(result.webSearchErrors![0]).toMatchObject({
      code: 'too_many_requests',
      round: 1,
    });
    expect(result.webSearchErrors![0].occurredAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T/,
    );
  });

  it('stream() maps unknown error_code to "unavailable" rather than crashing', async () => {
    const finalMessage = buildMessage({
      content: [
        {
          type: 'web_search_tool_result',
          tool_use_id: 'srvtoolu_err',
          content: {
            type: 'web_search_tool_result_error',
            error_code: 'some_future_code_we_dont_know_about',
          },
        },
      ] as unknown as Message['content'],
      usage: buildUsageWithTelemetry({ input: 1, output: 1 }),
    });
    const provider = new ClaudeProvider({
      apiKey: 'k',
      _internalClient: buildFakeClient({ streamFinal: finalMessage }),
    });
    const result = await provider.stream('sys', 'user', () => {});
    expect(result.webSearchErrors).toHaveLength(1);
    expect(result.webSearchErrors![0].code).toBe('unavailable');
  });

  it('complete() surfaces cache fields but omits zeros (mirrors stream() policy)', async () => {
    const provider = new ClaudeProvider({
      apiKey: 'k',
      _internalClient: buildFakeClient({
        completeMessage: buildMessage({
          content: [
            { type: 'text', text: 'x', citations: null },
          ] as Message['content'],
          usage: buildUsageWithTelemetry({
            input: 20,
            output: 10,
            cacheRead: 15,
            // cacheCreate intentionally 0 → should be omitted
          }),
        }),
      }),
    });
    const result = await provider.complete('sys', 'user');
    expect(result.usage).toEqual({
      tokensIn: 20,
      tokensOut: 10,
      cacheReadInputTokens: 15,
    });
  });
});

describe('ClaudeProvider model resolution', () => {
  it('getModel returns config value, override wins', () => {
    const provider = new ClaudeProvider({
      apiKey: 'k',
      model: 'configured',
      _internalClient: buildFakeClient({}),
    });
    expect(provider.getModel()).toBe('configured');
    expect(provider.getModel('overridden')).toBe('overridden');
  });

  it('getUtilityModel returns utilityModel config value, override wins', () => {
    const provider = new ClaudeProvider({
      apiKey: 'k',
      utilityModel: 'haiku-cfg',
      _internalClient: buildFakeClient({}),
    });
    expect(provider.getUtilityModel()).toBe('haiku-cfg');
    expect(provider.getUtilityModel('opus-override')).toBe('opus-override');
  });

  it('exposes provider name', () => {
    const provider = new ClaudeProvider({
      apiKey: 'k',
      _internalClient: buildFakeClient({}),
    });
    expect(provider.name).toBe('claude');
  });
});
