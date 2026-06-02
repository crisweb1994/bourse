import type OpenAI from 'openai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAIProvider } from '../../../primitives/provider/openai';

/**
 * Hotfix (2026-05-16) — OPENAI_USE_CHAT_COMPLETIONS env flag routes
 * stream() + complete() through legacy /v1/chat/completions instead of
 * /v1/responses (which DeepSeek / Qwen / Kimi / etc do not implement).
 */

function buildChatCompletionsStreamMock(chunks: Array<{
  choices?: Array<{ delta?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}>): AsyncIterable<unknown> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) yield c;
    },
  };
}

function buildChatCompletionsClient(opts: {
  streamChunks?: Array<{
    choices?: Array<{ delta?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  }>;
  createResponse?: {
    choices: Array<{ message: { content: string | null } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
}) {
  const captured: { params: Record<string, unknown> | null } = { params: null };
  const create = vi.fn(async (params: unknown) => {
    captured.params = params as Record<string, unknown>;
    const p = params as { stream?: boolean };
    if (p.stream) {
      return buildChatCompletionsStreamMock(opts.streamChunks ?? []);
    }
    return opts.createResponse ?? { choices: [{ message: { content: '' } }] };
  });
  const client = {
    chat: { completions: { create } },
    // responses must NOT be called on this path; setting it to a throwing
    // shim catches any accidental fallback back to responses.
    responses: {
      stream: vi.fn(() => {
        throw new Error('responses.stream MUST NOT be called when env is set');
      }),
      create: vi.fn(() => {
        throw new Error('responses.create MUST NOT be called when env is set');
      }),
    },
  } as unknown as OpenAI;
  return { client, captured, create };
}

describe('OpenAIProvider OPENAI_USE_CHAT_COMPLETIONS=true — stream path', () => {
  const originalFlag = process.env.OPENAI_USE_CHAT_COMPLETIONS;
  afterEach(() => {
    if (originalFlag === undefined) delete process.env.OPENAI_USE_CHAT_COMPLETIONS;
    else process.env.OPENAI_USE_CHAT_COMPLETIONS = originalFlag;
  });

  it('routes through chat.completions.create instead of responses.stream', async () => {
    process.env.OPENAI_USE_CHAT_COMPLETIONS = 'true';
    const { client, captured } = buildChatCompletionsClient({
      streamChunks: [
        { choices: [{ delta: { content: 'hello ' } }] },
        { choices: [{ delta: { content: 'world' } }] },
        { usage: { prompt_tokens: 10, completion_tokens: 5 } },
      ],
    });
    const provider = new OpenAIProvider({
      apiKey: 'k',
      _internalClient: client,
    });

    const collected: string[] = [];
    const result = await provider.stream('sys', 'user', (chunk) => {
      if (chunk.type === 'text') collected.push(chunk.text);
    });

    expect(captured.params).toBeTruthy();
    expect((captured.params as { model: string }).model).toBeTruthy();
    expect((captured.params as { stream: boolean }).stream).toBe(true);
    expect((captured.params as { tools?: unknown }).tools).toBeUndefined();
    expect(collected).toEqual(['hello ', 'world']);
    expect(result.text).toBe('hello world');
    expect(result.usage).toEqual({ tokensIn: 10, tokensOut: 5 });
  });

  it('flag unset → responses.stream path (original behavior preserved)', async () => {
    delete process.env.OPENAI_USE_CHAT_COMPLETIONS;
    const { client } = buildChatCompletionsClient({});
    const provider = new OpenAIProvider({
      apiKey: 'k',
      _internalClient: client,
    });
    // responses.stream throws by construction — flag unset means we DO
    // go through that path and hit the throw.
    await expect(provider.stream('sys', 'user', () => {})).rejects.toThrow(
      /MUST NOT be called/,
    );
  });

  it('passes both system + user messages with role labels', async () => {
    process.env.OPENAI_USE_CHAT_COMPLETIONS = 'true';
    const { client, captured } = buildChatCompletionsClient({
      streamChunks: [{ choices: [{ delta: { content: 'ok' } }] }],
    });
    const provider = new OpenAIProvider({
      apiKey: 'k',
      _internalClient: client,
    });
    await provider.stream('SYS_PROMPT', 'USER_PROMPT', () => {});

    const messages = (captured.params as {
      messages: Array<{ role: string; content: string }>;
    }).messages;
    expect(messages[0]).toEqual({ role: 'system', content: 'SYS_PROMPT' });
    expect(messages[1]).toEqual({ role: 'user', content: 'USER_PROMPT' });
  });
});

describe('OpenAIProvider OPENAI_USE_CHAT_COMPLETIONS=true — complete path', () => {
  const originalFlag = process.env.OPENAI_USE_CHAT_COMPLETIONS;
  afterEach(() => {
    if (originalFlag === undefined) delete process.env.OPENAI_USE_CHAT_COMPLETIONS;
    else process.env.OPENAI_USE_CHAT_COMPLETIONS = originalFlag;
  });

  it('routes through chat.completions.create (minimal request body, no response_format by default)', async () => {
    process.env.OPENAI_USE_CHAT_COMPLETIONS = 'true';
    delete process.env.OPENAI_CHAT_RESPONSE_FORMAT;
    const { client, captured } = buildChatCompletionsClient({
      createResponse: {
        choices: [{ message: { content: '{"ok":true}' } }],
        usage: { prompt_tokens: 8, completion_tokens: 3 },
      },
    });
    const provider = new OpenAIProvider({
      apiKey: 'k',
      _internalClient: client,
    });

    const result = await provider.complete('sys', 'user');
    expect(result.text).toBe('{"ok":true}');
    expect(result.usage).toEqual({ tokensIn: 8, tokensOut: 3 });
    const params = captured.params as {
      response_format?: { type: string };
      stream?: boolean;
    };
    // Hotfix 2026-05-16: response_format NOT sent by default (some
    // OpenAI-compatible vendors return 400 on it). Opt-in via env.
    expect(params.response_format).toBeUndefined();
    expect(params.stream).toBeUndefined();
  });

  it('opt-in OPENAI_CHAT_RESPONSE_FORMAT=true sends response_format=json_object', async () => {
    process.env.OPENAI_USE_CHAT_COMPLETIONS = 'true';
    process.env.OPENAI_CHAT_RESPONSE_FORMAT = 'true';
    const { client, captured } = buildChatCompletionsClient({
      createResponse: { choices: [{ message: { content: '{}' } }] },
    });
    const provider = new OpenAIProvider({
      apiKey: 'k',
      _internalClient: client,
    });
    await provider.complete('sys', 'user');
    const params = captured.params as { response_format?: { type: string } };
    expect(params.response_format).toEqual({ type: 'json_object' });
    delete process.env.OPENAI_CHAT_RESPONSE_FORMAT;
  });

  it('stream path: stream_options NOT sent by default; opt-in via OPENAI_CHAT_STREAM_USAGE', async () => {
    process.env.OPENAI_USE_CHAT_COMPLETIONS = 'true';

    // Default: no stream_options
    delete process.env.OPENAI_CHAT_STREAM_USAGE;
    const { client: c1, captured: cap1 } = buildChatCompletionsClient({
      streamChunks: [{ choices: [{ delta: { content: 'x' } }] }],
    });
    await new OpenAIProvider({ apiKey: 'k', _internalClient: c1 }).stream(
      'sys',
      'user',
      () => {},
    );
    expect((cap1.params as Record<string, unknown>).stream_options).toBeUndefined();

    // Opt-in: stream_options present
    process.env.OPENAI_CHAT_STREAM_USAGE = 'true';
    const { client: c2, captured: cap2 } = buildChatCompletionsClient({
      streamChunks: [{ choices: [{ delta: { content: 'y' } }] }],
    });
    await new OpenAIProvider({ apiKey: 'k', _internalClient: c2 }).stream(
      'sys',
      'user',
      () => {},
    );
    expect((cap2.params as Record<string, unknown>).stream_options).toEqual({
      include_usage: true,
    });
    delete process.env.OPENAI_CHAT_STREAM_USAGE;
  });
});
