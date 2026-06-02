import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { StructuredOutputError } from '../../primitives/errors';
import type {
  AgentProvider,
  ProviderCompleteResult,
} from '../../primitives/provider';
import { structuredOutputWithRepair } from '../../primitives/structured-output';

const schema = z.object({ name: z.string(), value: z.number() });

function fakeProvider(
  completeResults: ProviderCompleteResult[],
): AgentProvider {
  let i = 0;
  return {
    name: 'fake',
    stream: vi.fn(),
    complete: vi.fn(async () => completeResults[i++]!),
    getModel: () => 'm',
    getUtilityModel: () => 'jm',
  };
}

describe('primitives/structuredOutputWithRepair', () => {
  it('returns immediately when first parse succeeds', async () => {
    const provider = fakeProvider([
      { text: '{"name":"x","value":1}', usage: { tokensIn: 10, tokensOut: 5 } },
    ]);
    const out = await structuredOutputWithRepair(provider, 'sys', 'user', schema);
    expect(out.data).toEqual({ name: 'x', value: 1 });
    expect(out.usage).toEqual({ tokensIn: 10, tokensOut: 5 });
    expect(provider.complete).toHaveBeenCalledTimes(1);
  });

  it('strips ```json fences before parsing', async () => {
    const provider = fakeProvider([
      { text: '```json\n{"name":"x","value":2}\n```', usage: { tokensIn: 1, tokensOut: 1 } },
    ]);
    const out = await structuredOutputWithRepair(provider, 'sys', 'user', schema);
    expect(out.data).toEqual({ name: 'x', value: 2 });
    expect(provider.complete).toHaveBeenCalledTimes(1);
  });

  it('repairs after one failed parse and accumulates usage', async () => {
    const provider = fakeProvider([
      { text: '{not json', usage: { tokensIn: 100, tokensOut: 50 } },
      { text: '{"name":"y","value":3}', usage: { tokensIn: 200, tokensOut: 80 } },
    ]);
    const out = await structuredOutputWithRepair(provider, 'sys', 'user', schema);
    expect(out.data).toEqual({ name: 'y', value: 3 });
    expect(out.usage).toEqual({ tokensIn: 300, tokensOut: 130 });
    expect(provider.complete).toHaveBeenCalledTimes(2);
  });

  it('repair prompt carries original user prompt + bad output + zod error', async () => {
    let secondUserPrompt = '';
    const completeMock = vi
      .fn<(s: string, u: string) => Promise<ProviderCompleteResult>>()
      .mockImplementationOnce(async () => ({
        text: '{"name":"x"}', // missing 'value' → schema fails
        usage: { tokensIn: 1, tokensOut: 1 },
      }))
      .mockImplementationOnce(async (_s, u) => {
        secondUserPrompt = u;
        return { text: '{"name":"x","value":9}', usage: { tokensIn: 1, tokensOut: 1 } };
      });
    const provider: AgentProvider = {
      name: 'fake',
      stream: vi.fn(),
      complete: completeMock,
      getModel: () => 'm',
      getUtilityModel: () => 'jm',
    };

    await structuredOutputWithRepair(provider, 'sys', 'orig user prompt', schema);

    expect(secondUserPrompt).toContain('orig user prompt');
    expect(secondUserPrompt).toContain('# 上次输出');
    expect(secondUserPrompt).toContain('# 校验错误');
    expect(secondUserPrompt).toContain('{"name":"x"}');
  });

  it('throws StructuredOutputError after second failure', async () => {
    const provider = fakeProvider([
      { text: 'garbage 1' },
      { text: 'still garbage' },
    ]);
    await expect(
      structuredOutputWithRepair(provider, 'sys', 'user', schema),
    ).rejects.toBeInstanceOf(StructuredOutputError);
  });

  it('handles provider returning no usage gracefully', async () => {
    const provider = fakeProvider([{ text: '{"name":"x","value":1}' }]);
    const out = await structuredOutputWithRepair(provider, 'sys', 'user', schema);
    expect(out.usage).toEqual({ tokensIn: 0, tokensOut: 0 });
  });
});
