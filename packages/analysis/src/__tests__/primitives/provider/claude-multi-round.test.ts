import type Anthropic from '@anthropic-ai/sdk';
import type {
  Message,
  RawMessageStreamEvent,
} from '@anthropic-ai/sdk/resources/messages/messages';
import { describe, expect, it, vi } from 'vitest';
import { ClaudeProvider } from '../../../primitives/provider/claude';
import type { ProviderStreamChunk } from '../../../primitives/provider/types';

// Reuse minimal fixtures from claude.test.ts (kept local to avoid cross-file
// coupling).
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

const textDelta = (text: string): RawMessageStreamEvent =>
  ({
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text },
  }) as RawMessageStreamEvent;

const citationDelta = (
  url: string,
  title: string,
): RawMessageStreamEvent =>
  ({
    type: 'content_block_delta',
    index: 0,
    delta: {
      type: 'citations_delta',
      citation: {
        type: 'web_search_result_location',
        cited_text: 'snippet',
        encrypted_index: 'enc',
        url,
        title,
      },
    },
  }) as RawMessageStreamEvent;

/**
 * Each entry corresponds to one provider.stream → messages.stream() call.
 * The fake dispatches calls in order: 1st call → rounds[0], etc.
 */
function buildSequencedClient(
  rounds: Array<{
    events: RawMessageStreamEvent[];
    final: Message;
  }>,
  onCall?: (params: unknown, callIdx: number) => void,
): Anthropic {
  let callIdx = 0;
  const stream = vi.fn((params: unknown) => {
    const r = rounds[callIdx];
    if (!r) {
      throw new Error(
        `Fake Anthropic client: unexpected stream() call #${callIdx + 1}`,
      );
    }
    onCall?.(params, callIdx);
    callIdx++;
    return buildStreamMock(r.events, r.final);
  });
  const create = vi.fn(async () => buildMessage());
  return { messages: { stream, create } } as unknown as Anthropic;
}

// ===== Tests =====

describe('ClaudeProvider.stream — multi-round', () => {
  it('runs 1 round when no rounds option (backwards-compat)', async () => {
    let callCount = 0;
    const provider = new ClaudeProvider({
      apiKey: 'k',
      _internalClient: buildSequencedClient(
        [{ events: [textDelta('hello')], final: buildMessage() }],
        () => {
          callCount++;
        },
      ),
    });
    const result = await provider.stream('sys', 'user', () => {});
    expect(callCount).toBe(1);
    expect(result.text).toBe('hello');
  });

  it('runs 2 rounds when rounds has 1 entry; aggregates text with separator', async () => {
    let callCount = 0;
    const provider = new ClaudeProvider({
      apiKey: 'k',
      _internalClient: buildSequencedClient(
        [
          {
            events: [textDelta('round-1-text')],
            final: buildMessage({ usage: buildUsage(100, 50) }),
          },
          {
            events: [textDelta('round-2-text')],
            final: buildMessage({ usage: buildUsage(200, 80) }),
          },
        ],
        () => {
          callCount++;
        },
      ),
    });

    const chunks: ProviderStreamChunk[] = [];
    const result = await provider.stream(
      'sys',
      'user1',
      (c) => chunks.push(c),
      { rounds: [{ userPrompt: 'user2' }] },
    );

    expect(callCount).toBe(2);
    expect(result.text).toBe('round-1-text\n\n---\n\nround-2-text');
    expect(result.usage).toEqual({ tokensIn: 300, tokensOut: 130 });

    // Three text chunks emitted: round1 text + separator + round2 text.
    const textChunks = chunks.filter((c) => c.type === 'text');
    expect(textChunks.map((c) => (c as { text: string }).text)).toEqual([
      'round-1-text',
      '\n\n---\n\n',
      'round-2-text',
    ]);
  });

  it('passes assistant content from round 1 into round 2 messages', async () => {
    const round1Content = [
      { type: 'text', text: 'round 1 output', citations: null },
    ] as Message['content'];

    const captured: Array<{ messages: unknown; idx: number }> = [];
    const provider = new ClaudeProvider({
      apiKey: 'k',
      _internalClient: buildSequencedClient(
        [
          {
            events: [textDelta('round 1 output')],
            final: buildMessage({ content: round1Content }),
          },
          {
            events: [textDelta('round 2 output')],
            final: buildMessage(),
          },
        ],
        (params, idx) => {
          // Snapshot the messages array — provider mutates it across rounds,
          // so capturing the reference would show post-mutation state.
          const msgs = (params as { messages: unknown[] }).messages;
          captured.push({
            messages: [...msgs],
            idx,
          });
        },
      ),
    });

    await provider.stream('sys', 'user1', () => {}, {
      rounds: [{ userPrompt: 'user2' }],
    });

    // Round 1: messages = [{ role: 'user', content: 'user1' }]
    expect((captured[0]!.messages as unknown[]).length).toBe(1);

    // Round 2: messages = [user1, assistant(round1 content blocks), user2]
    const r2 = captured[1]!.messages as Array<{ role: string }>;
    expect(r2.length).toBe(3);
    expect(r2[0]!.role).toBe('user');
    expect(r2[1]!.role).toBe('assistant');
    expect(r2[2]!.role).toBe('user');
  });

  it('deduplicates citations across rounds', async () => {
    const sharedUrl = 'https://example.com/shared';
    const provider = new ClaudeProvider({
      apiKey: 'k',
      _internalClient: buildSequencedClient([
        {
          events: [
            textDelta('r1'),
            citationDelta(sharedUrl, 'Shared'),
            citationDelta('https://example.com/r1', 'R1 only'),
          ],
          final: buildMessage(),
        },
        {
          events: [
            textDelta('r2'),
            citationDelta(sharedUrl, 'Shared'), // dup
            citationDelta('https://example.com/r2', 'R2 only'),
          ],
          final: buildMessage(),
        },
      ]),
    });

    const result = await provider.stream('sys', 'user1', () => {}, {
      rounds: [{ userPrompt: 'user2' }],
    });
    expect(result.citations.map((c) => c.url)).toEqual([
      sharedUrl,
      'https://example.com/r1',
      'https://example.com/r2',
    ]);
  });

  it('sums toolUseCounts across rounds', async () => {
    const provider = new ClaudeProvider({
      apiKey: 'k',
      _internalClient: buildSequencedClient([
        {
          events: [textDelta('r1')],
          final: buildMessage({
            content: [
              { type: 'server_tool_use', id: 'a', name: 'web_search', input: {} },
              { type: 'server_tool_use', id: 'b', name: 'web_search', input: {} },
            ] as Message['content'],
          }),
        },
        {
          events: [textDelta('r2')],
          final: buildMessage({
            content: [
              { type: 'server_tool_use', id: 'c', name: 'web_search', input: {} },
            ] as Message['content'],
          }),
        },
      ]),
    });

    const result = await provider.stream('sys', 'user1', () => {}, {
      rounds: [{ userPrompt: 'user2' }],
    });
    expect(result.toolUseCounts).toEqual({ webSearch: 3 });
  });

  it('invokes onRoundComplete after each round with round number and text', async () => {
    const calls: Array<{ round: number; text: string }> = [];
    const provider = new ClaudeProvider({
      apiKey: 'k',
      _internalClient: buildSequencedClient([
        { events: [textDelta('A')], final: buildMessage() },
        { events: [textDelta('B')], final: buildMessage() },
      ]),
    });

    await provider.stream('sys', 'user1', () => {}, {
      rounds: [{ userPrompt: 'user2' }],
      onRoundComplete: (round, text) => calls.push({ round, text }),
    });
    expect(calls).toEqual([
      { round: 1, text: 'A' },
      { round: 2, text: 'B' },
    ]);
  });

  it('respects per-round maxToolUses cap in tool spec', async () => {
    const capturedToolSpecs: Array<{ max_uses: number }> = [];
    const provider = new ClaudeProvider({
      apiKey: 'k',
      _internalClient: buildSequencedClient(
        [
          { events: [textDelta('r1')], final: buildMessage() },
          { events: [textDelta('r2')], final: buildMessage() },
        ],
        (params) => {
          const tools = (params as { tools: Array<{ max_uses: number }> })
            .tools;
          capturedToolSpecs.push(tools[0]!);
        },
      ),
    });

    await provider.stream('sys', 'user1', () => {}, {
      maxToolUses: 5,
      rounds: [{ userPrompt: 'user2', maxToolUses: 2 }],
    });

    // Round 1 uses options.maxToolUses (5). Round 2 uses its own (2).
    expect(capturedToolSpecs.map((t) => t.max_uses)).toEqual([5, 2]);
  });
});
