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
 * web_search server tool is always available; the only opt-out is the
 * per-call `options.disableTools` (used by the summary stage). The former
 * DISABLE_WEB_SEARCH env kill switch was removed — web_search is now baked on.
 */

function buildAnthropicMessage(): Message {
  return {
    id: 'm',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-4-20250514',
    content: [],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      server_tool_use: null,
      service_tier: null,
      cache_creation: null,
      inference_geo: null,
    },
  } as unknown as Message;
}

function buildAnthropicStreamMock(): AsyncIterable<RawMessageStreamEvent> & {
  finalMessage: () => Promise<Message>;
} {
  const asyncIter = (async function* () {})();
  return Object.assign(asyncIter, {
    finalMessage: vi.fn(() => Promise.resolve(buildAnthropicMessage())),
  });
}

function buildAnthropicCapturingClient() {
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

function buildOpenAIStreamMock(): AsyncIterable<unknown> & {
  finalResponse: () => Promise<unknown>;
} {
  const asyncIter = (async function* () {})();
  return Object.assign(asyncIter, {
    finalResponse: vi.fn(() =>
      Promise.resolve({ output: [], output_text: '' }),
    ),
  });
}

function buildOpenAICapturingClient() {
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

describe('web_search always available — ClaudeProvider', () => {
  it('default → tools field present', async () => {
    const { client, captured } = buildAnthropicCapturingClient();
    const provider = new ClaudeProvider({
      apiKey: 'k',
      _internalClient: client,
    });
    await provider.stream('sys', 'user', () => {});
    expect(captured.params).toHaveProperty('tools');
  });

  it('options.disableTools=true → tools field omitted (per-call opt-out)', async () => {
    const { client, captured } = buildAnthropicCapturingClient();
    const provider = new ClaudeProvider({
      apiKey: 'k',
      _internalClient: client,
    });
    await provider.stream('sys', 'user', () => {}, { disableTools: true });
    expect(captured.params).not.toHaveProperty('tools');
  });
});

describe('web_search always available — OpenAIProvider', () => {
  it('default → tools field present', async () => {
    const { client, captured } = buildOpenAICapturingClient();
    const provider = new OpenAIProvider({
      apiKey: 'k',
      _internalClient: client,
    });
    await provider.stream('sys', 'user', () => {});
    expect(captured.params).toHaveProperty('tools');
  });

  it('options.disableTools=true → tools field omitted (per-call opt-out)', async () => {
    const { client, captured } = buildOpenAICapturingClient();
    const provider = new OpenAIProvider({
      apiKey: 'k',
      _internalClient: client,
    });
    await provider.stream('sys', 'user', () => {}, { disableTools: true });
    expect(captured.params).not.toHaveProperty('tools');
  });
});
