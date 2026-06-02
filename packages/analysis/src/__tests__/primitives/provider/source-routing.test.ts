import type Anthropic from '@anthropic-ai/sdk';
import type {
  Message,
  RawMessageStreamEvent,
} from '@anthropic-ai/sdk/resources/messages/messages';
import type OpenAI from 'openai';
import { describe, expect, it, vi } from 'vitest';
import { ClaudeProvider } from '../../../primitives/provider/claude';
import { OpenAIProvider } from '../../../primitives/provider/openai';

/**
 * RFC-06: provider injection of `allowed_domains` (Anthropic) /
 * `filters.allowed_domains` (OpenAI) into the web_search tool config.
 *
 * Tests stay narrow: they verify the *shape* of params sent to the SDK,
 * not request behavior — that's the SDK's job. We capture the params via
 * an `_internalClient` shim and assert directly.
 */

// ===== Anthropic fake client (mirrors claude.test.ts pattern) =====

function buildAnthropicUsage(): Message['usage'] {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    server_tool_use: null,
    service_tier: null,
    cache_creation: null,
    inference_geo: null,
  } as Message['usage'];
}

function buildAnthropicMessage(): Message {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-4-20250514',
    content: [],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: buildAnthropicUsage(),
  } as unknown as Message;
}

function buildAnthropicStreamMock(): AsyncIterable<RawMessageStreamEvent> & {
  finalMessage: () => Promise<Message>;
} {
  const asyncIter = (async function* () {
    // intentionally empty: we only inspect params, not stream content
  })();
  return Object.assign(asyncIter, {
    finalMessage: vi.fn(() => Promise.resolve(buildAnthropicMessage())),
  });
}

function buildAnthropicCapturingClient(): {
  client: Anthropic;
  captured: { params: Record<string, unknown> | null };
} {
  const captured: { params: Record<string, unknown> | null } = { params: null };
  const stream = vi.fn((params: unknown) => {
    captured.params = params as Record<string, unknown>;
    return buildAnthropicStreamMock();
  });
  const client = {
    messages: { stream, create: vi.fn() },
  } as unknown as Anthropic;
  return { client, captured };
}

// ===== OpenAI fake client =====

function buildOpenAIStreamMock(): AsyncIterable<unknown> & {
  finalResponse: () => Promise<unknown>;
} {
  const asyncIter = (async function* () {
    // intentionally empty
  })();
  return Object.assign(asyncIter, {
    finalResponse: vi.fn(() =>
      Promise.resolve({ output: [], output_text: '' }),
    ),
  });
}

function buildOpenAICapturingClient(): {
  client: OpenAI;
  captured: { params: Record<string, unknown> | null };
} {
  const captured: { params: Record<string, unknown> | null } = { params: null };
  const stream = vi.fn(async (params: unknown) => {
    captured.params = params as Record<string, unknown>;
    return buildOpenAIStreamMock();
  });
  const client = {
    responses: { stream, create: vi.fn() },
  } as unknown as OpenAI;
  return { client, captured };
}

// ===== Tests =====

describe('ClaudeProvider RFC-06 source routing', () => {
  it('omits allowed_domains when option is undefined (legacy behavior)', async () => {
    const { client, captured } = buildAnthropicCapturingClient();
    const provider = new ClaudeProvider({ apiKey: 'k', _internalClient: client });
    await provider.stream('sys', 'user', () => {});
    const tools = captured.params!.tools as Array<Record<string, unknown>>;
    expect(tools).toHaveLength(1);
    expect(tools[0]!.type).toBe('web_search_20250305');
    expect(tools[0]).not.toHaveProperty('allowed_domains');
  });

  it('omits allowed_domains when option is an empty array', async () => {
    const { client, captured } = buildAnthropicCapturingClient();
    const provider = new ClaudeProvider({ apiKey: 'k', _internalClient: client });
    await provider.stream('sys', 'user', () => {}, { allowedDomains: [] });
    const tools = captured.params!.tools as Array<Record<string, unknown>>;
    expect(tools[0]).not.toHaveProperty('allowed_domains');
  });

  it('passes allowed_domains into web_search_20250305 when option is set', async () => {
    const { client, captured } = buildAnthropicCapturingClient();
    const provider = new ClaudeProvider({ apiKey: 'k', _internalClient: client });
    await provider.stream('sys', 'user', () => {}, {
      allowedDomains: ['cninfo.com.cn', 'eastmoney.com'],
    });
    const tools = captured.params!.tools as Array<Record<string, unknown>>;
    expect(tools[0]!.allowed_domains).toEqual([
      'cninfo.com.cn',
      'eastmoney.com',
    ]);
  });

  it('does not inject allowed_domains when tools are disabled', async () => {
    const { client, captured } = buildAnthropicCapturingClient();
    const provider = new ClaudeProvider({ apiKey: 'k', _internalClient: client });
    await provider.stream('sys', 'user', () => {}, {
      disableTools: true,
      allowedDomains: ['cninfo.com.cn'],
    });
    expect(captured.params!.tools).toBeUndefined();
  });
});

describe('OpenAIProvider RFC-06 source routing', () => {
  it('omits filters when option is undefined (legacy behavior)', async () => {
    const { client, captured } = buildOpenAICapturingClient();
    const provider = new OpenAIProvider({ apiKey: 'k', _internalClient: client });
    await provider.stream('sys', 'user', () => {});
    const tools = captured.params!.tools as Array<Record<string, unknown>>;
    expect(tools).toHaveLength(1);
    expect(tools[0]!.type).toBe('web_search');
    expect(tools[0]).not.toHaveProperty('filters');
  });

  it('omits filters when option is an empty array', async () => {
    const { client, captured } = buildOpenAICapturingClient();
    const provider = new OpenAIProvider({ apiKey: 'k', _internalClient: client });
    await provider.stream('sys', 'user', () => {}, { allowedDomains: [] });
    const tools = captured.params!.tools as Array<Record<string, unknown>>;
    expect(tools[0]).not.toHaveProperty('filters');
  });

  it('passes filters.allowed_domains into web_search tool config when set', async () => {
    const { client, captured } = buildOpenAICapturingClient();
    const provider = new OpenAIProvider({ apiKey: 'k', _internalClient: client });
    await provider.stream('sys', 'user', () => {}, {
      allowedDomains: ['cninfo.com.cn', 'sse.com.cn'],
    });
    const tools = captured.params!.tools as Array<Record<string, unknown>>;
    expect(tools[0]!.filters).toEqual({
      allowed_domains: ['cninfo.com.cn', 'sse.com.cn'],
    });
  });

  it('does not inject filters when tools are disabled', async () => {
    const { client, captured } = buildOpenAICapturingClient();
    const provider = new OpenAIProvider({ apiKey: 'k', _internalClient: client });
    await provider.stream('sys', 'user', () => {}, {
      disableTools: true,
      allowedDomains: ['cninfo.com.cn'],
    });
    expect(captured.params!.tools).toBeUndefined();
  });
});
