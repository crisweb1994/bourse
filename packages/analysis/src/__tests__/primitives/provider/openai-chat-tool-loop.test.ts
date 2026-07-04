/**
 * Coverage gap fix: `streamChatCompletions`'s web_search tool-call loop
 * (openai.ts ~531-759) had no direct unit test — the existing
 * openai-chat-completions.test.ts only covers the no-executor path
 * (default `disableTools` / no env). This file injects a fake executor
 * via `webSearchExecutorFactory` and drives a 2-round loop:
 *
 *   round 0: assistant emits tool_calls(web_search) → executor.execute
 *            → role:'tool' message appended → loop continues
 *   round 1: assistant emits plain content → loop exits
 *
 * Plus a budget-exhausted variant where `result.budgetExhausted=true`
 * injects the "stop searching" user message.
 */
import type OpenAI from 'openai';
import { describe, expect, it, vi } from 'vitest';
import { OpenAIProvider } from '../../../primitives/provider/openai';
import type {
  ExecuteResult,
  WebSearchExecutor,
} from '../../../tools/web-search/executor';

function asyncStream(
  chunks: Array<Record<string, unknown>>,
): AsyncIterable<Record<string, unknown>> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) yield c;
    },
  };
}

/**
 * Build a fake OpenAI client whose chat.completions.create replays a
 * pre-scripted list of rounds. Each round's chunk list is consumed in
 * call order. The captured array records every call's params so tests
 * can assert message accumulation between rounds.
 */
function buildScriptedClient(rounds: Array<Array<Record<string, unknown>>>) {
  let callIdx = -1;
  const captured: Array<Record<string, unknown>> = [];
  const create = vi.fn(async (params: unknown) => {
    callIdx += 1;
    captured.push(params as Record<string, unknown>);
    const chunks = rounds[callIdx] ?? [];
    return asyncStream(chunks);
  });
  const client = {
    chat: { completions: { create } },
    responses: {
      stream: vi.fn(() => {
        throw new Error('responses path must not run on chat-completions route');
      }),
      create: vi.fn(() => {
        throw new Error('responses path must not run on chat-completions route');
      }),
    },
  } as unknown as OpenAI;
  return { client, captured };
}

function buildFakeExecutor(result: Partial<ExecuteResult>): WebSearchExecutor {
  return {
    execute: vi.fn(async () => {
      return {
        output: {
          text: 'search snippet text',
          citations: [
            {
              title: 'Hit',
              url: 'https://src.example.com/a',
              sourceType: 'NEWS',
              retrievedAt: '2026-05-19T00:00:00Z',
            },
          ],
          results: { items: [{ title: 'Hit', url: 'https://src.example.com/a' }] },
        },
        budgetExhausted: false,
        ...result,
      } as ExecuteResult;
    }),
  } as unknown as WebSearchExecutor;
}

describe('OpenAIProvider chat.completions — web_search tool-call loop', () => {
  it('accumulates tool_calls, runs executor, appends role:tool message, exits on plain content', async () => {
    // Round 0: model requests one web_search call.
    // Sparse deltas: id+name on first, arguments string split across two chunks.
    const round0 = [
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_1',
                  type: 'function',
                  function: { name: 'web_search', arguments: '{"query":"AAPL' },
                },
              ],
            },
          },
        ],
      },
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, function: { arguments: ' news"}' } },
              ],
            },
          },
        ],
      },
      { choices: [{ finish_reason: 'tool_calls' }] },
    ];
    // Round 1: model produces final content, no more tool calls.
    const round1 = [
      { choices: [{ delta: { content: 'final answer' } }] },
      { choices: [{ finish_reason: 'stop' }] },
    ];

    const executor = buildFakeExecutor({});
    const { client, captured } = buildScriptedClient([round0, round1]);

    const provider = new OpenAIProvider({
      apiKey: 'k',
      forceChatCompletions: true,
      webSearchExecutorFactory: () => executor,
      _internalClient: client,
    });

    const chunks: Array<{ type: string; text?: string; citation?: unknown }> = [];
    const result = await provider.stream('sys', 'user', (c) => chunks.push(c));

    // Executor was called exactly once (round 0's single tool_call).
    expect(executor.execute).toHaveBeenCalledTimes(1);
    expect(executor.execute).toHaveBeenCalledWith(
      expect.objectContaining({ query: 'AAPL news' }),
      undefined,
    );

    // toolUseCounts.webSearch bumped once.
    expect(result.toolUseCounts?.webSearch).toBe(1);

    // Citation from executor was forwarded via onChunk + result.citations.
    expect(
      chunks.some(
        (c) =>
          c.type === 'citation' &&
          (c.citation as { url: string }).url === 'https://src.example.com/a',
      ),
    ).toBe(true);
    expect(
      result.citations.some((c) => c.url === 'https://src.example.com/a'),
    ).toBe(true);

    // Final text from round 1 surfaced.
    expect(result.text).toContain('final answer');

    // Round 1's request (captured[1]) carried the assistant tool_calls +
    // the role:'tool' reply — proving the loop accumulated state across
    // rounds and fed it back to the API.
    const round1Messages = captured[1]!.messages as Array<{
      role: string;
      tool_calls?: unknown[];
      tool_call_id?: string;
      content?: string;
    }>;
    const assistantTurn = round1Messages.find(
      (m) => m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0,
    );
    expect(assistantTurn).toBeDefined();
    const toolReply = round1Messages.find((m) => m.role === 'tool');
    expect(toolReply).toBeDefined();
    expect(toolReply!.tool_call_id).toBe('call_1');
  });

  it('budgetExhausted=true injects the "stop searching" user message', async () => {
    const round0 = [
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_x',
                  type: 'function',
                  function: { name: 'web_search', arguments: '{"query":"q"}' },
                },
              ],
            },
          },
        ],
      },
      { choices: [{ finish_reason: 'tool_calls' }] },
    ];
    const round1 = [
      { choices: [{ delta: { content: 'done' } }] },
      { choices: [{ finish_reason: 'stop' }] },
    ];

    const executor = buildFakeExecutor({ budgetExhausted: true });
    const { client, captured } = buildScriptedClient([round0, round1]);

    const provider = new OpenAIProvider({
      apiKey: 'k',
      forceChatCompletions: true,
      webSearchExecutorFactory: () => executor,
      _internalClient: client,
    });

    await provider.stream('sys', 'user', () => {});

    // Round 1's message list contains the budget-stop user message
    // (zh-CN body, distinctive prefix) right after the tool reply.
    const round1Messages = captured[1]!.messages as Array<{
      role: string;
      content?: string;
    }>;
    const stopMsg = round1Messages.find(
      (m) =>
        m.role === 'user' &&
        typeof m.content === 'string' &&
        m.content.includes('网络搜索预算已用尽'),
    );
    expect(stopMsg).toBeDefined();
  });
});
