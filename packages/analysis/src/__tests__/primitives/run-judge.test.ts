import { describe, expect, it, vi } from 'vitest';
import type {
  AgentProvider,
  ProviderCompleteOptions,
  ProviderCompleteResult,
  ProviderStreamChunk,
  ProviderStreamOptions,
  ProviderStreamResult,
} from '../../primitives/provider';
import { runJudge } from '../../primitives/judge';

/**
 * RFC-10 P2 — runJudge primitive behavior.
 *
 * Tests inject a fake `AgentProvider` whose `complete()` returns scripted
 * text. We assert:
 *   - valid JudgeResult JSON parses + propagates through to .result
 *   - malformed first attempt → repair pass succeeds (llmCalls=2)
 *   - both attempts malformed → throws StructuredOutputError
 *   - abort signal forwarded to provider.complete
 *   - `complete()` is the path used (NOT `stream()`) — i.e. no web_search
 *     surface is even reachable
 */

function makeProvider(
  responses: Array<ProviderCompleteResult | Error>,
  onComplete?: (
    systemPrompt: string,
    userPrompt: string,
    options?: ProviderCompleteOptions,
  ) => void,
): AgentProvider {
  let idx = 0;
  return {
    name: 'fake',
    stream: vi.fn(
      async (
        _s: string,
        _u: string,
        _onChunk: (c: ProviderStreamChunk) => void,
        _o?: ProviderStreamOptions,
      ): Promise<ProviderStreamResult> => {
        throw new Error('stream() must not be called by runJudge');
      },
    ),
    complete: vi.fn(
      async (
        systemPrompt: string,
        userPrompt: string,
        options?: ProviderCompleteOptions,
      ): Promise<ProviderCompleteResult> => {
        onComplete?.(systemPrompt, userPrompt, options);
        const r = responses[idx++];
        if (r === undefined) throw new Error(`fake: unexpected call #${idx}`);
        if (r instanceof Error) throw r;
        return r;
      },
    ),
    getModel: () => 'fake-stream-model',
    getUtilityModel: () => 'fake-json-model',
  };
}

const validJudgeJson = JSON.stringify({
  schemaVersion: 'judge-result-v1',
  pass: false,
  concerns: ['PE assumes 30x but peerPE p50 is 18x — strong claim unsupported'],
  suggestedRevisions: ['Cite peer PE distribution; revise to MEDIUM'],
  confidenceAdjustment: 'DOWNGRADE_TO_MEDIUM',
});

const INPUT = {
  dimensionType: 'VALUATION' as const,
  evidencePackText: 'Symbol: 600519.SS\n财务快照: price=1820, PE=28',
  structuredJson: {
    conclusion: { signal: 'BULLISH', confidence: 'HIGH', oneLiner: 'strong' },
    evidence: [],
  },
  reportMarkdown: '# 估值\n报告内容...',
  citations: [
    {
      title: '巨潮',
      url: 'https://static.cninfo.com.cn/x',
      sourceType: 'FILING' as const,
      qualityTier: 'A' as const,
      retrievedAt: '2026-05-15T00:00:00.000Z',
    },
  ],
};

describe('primitives/runJudge — happy path', () => {
  it('parses valid JudgeResult on first attempt (llmCalls=1)', async () => {
    const provider = makeProvider([
      {
        text: validJudgeJson,
        usage: { tokensIn: 800, tokensOut: 120 },
        model: 'claude-test',
      },
    ]);

    const out = await runJudge(provider, INPUT);

    expect(out.result.pass).toBe(false);
    expect(out.result.confidenceAdjustment).toBe('DOWNGRADE_TO_MEDIUM');
    expect(out.result.concerns).toHaveLength(1);
    expect(out.trace.llmCalls).toBe(1);
    expect(out.trace.tokensIn).toBe(800);
    expect(out.trace.tokensOut).toBe(120);
    expect(out.trace.model).toBe('claude-test');
    expect(out.trace.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('uses complete() — never stream()', async () => {
    const provider = makeProvider([
      {
        text: validJudgeJson,
        usage: { tokensIn: 100, tokensOut: 50 },
        model: 'claude-test',
      },
    ]);

    await runJudge(provider, INPUT);

    expect(provider.complete).toHaveBeenCalledTimes(1);
    expect(provider.stream).not.toHaveBeenCalled();
  });
});

describe('primitives/runJudge — repair pass', () => {
  it('recovers when first response is malformed JSON', async () => {
    const provider = makeProvider([
      {
        text: 'I am happy to help! Here is the audit: {bad-json',
        usage: { tokensIn: 800, tokensOut: 60 },
        model: 'claude-test',
      },
      {
        text: validJudgeJson,
        usage: { tokensIn: 900, tokensOut: 110 },
        model: 'claude-test',
      },
    ]);

    const out = await runJudge(provider, INPUT);

    expect(out.result.pass).toBe(false);
    expect(out.trace.llmCalls).toBe(2);
    expect(out.trace.tokensIn).toBe(1700); // summed across attempts
    expect(out.trace.tokensOut).toBe(170);
  });

  it('throws when both attempts produce malformed output', async () => {
    const provider = makeProvider([
      {
        text: 'nope',
        usage: { tokensIn: 100, tokensOut: 10 },
        model: 'claude-test',
      },
      {
        text: 'still nope',
        usage: { tokensIn: 100, tokensOut: 10 },
        model: 'claude-test',
      },
    ]);

    await expect(runJudge(provider, INPUT)).rejects.toThrow();
  });
});

describe('primitives/runJudge — UPGRADE rejection', () => {
  it('throws when LLM tries to UPGRADE confidence (prompt-injection guard)', async () => {
    const evil = JSON.stringify({
      schemaVersion: 'judge-result-v1',
      pass: true,
      concerns: [],
      suggestedRevisions: [],
      confidenceAdjustment: 'UPGRADE_TO_HIGH', // not in enum
    });
    const provider = makeProvider([
      { text: evil, usage: { tokensIn: 100, tokensOut: 10 }, model: 'm' },
      { text: evil, usage: { tokensIn: 100, tokensOut: 10 }, model: 'm' },
    ]);

    await expect(runJudge(provider, INPUT)).rejects.toThrow();
  });
});

describe('primitives/runJudge — option forwarding', () => {
  it('forwards AbortSignal to provider.complete', async () => {
    const seen: ProviderCompleteOptions[] = [];
    const provider = makeProvider(
      [
        {
          text: validJudgeJson,
          usage: { tokensIn: 100, tokensOut: 10 },
          model: 'm',
        },
      ],
      (_s, _u, opts) => {
        if (opts) seen.push(opts);
      },
    );
    const controller = new AbortController();

    await runJudge(provider, INPUT, { signal: controller.signal });

    expect(seen).toHaveLength(1);
    expect(seen[0].signal).toBe(controller.signal);
  });

  it('uses judgeNeutral persona by default (system prompt mentions ANALYTICAL_JUDGE)', async () => {
    let capturedSystem = '';
    const provider = makeProvider(
      [
        {
          text: validJudgeJson,
          usage: { tokensIn: 100, tokensOut: 10 },
          model: 'm',
        },
      ],
      (sys) => {
        capturedSystem = sys;
      },
    );

    await runJudge(provider, INPUT);

    expect(capturedSystem).toContain('ANALYTICAL_JUDGE');
    expect(capturedSystem).toContain('RFC-10');
    expect(capturedSystem).toContain('schemaVersion');
  });

  it('truncates long reportMarkdown into the user prompt', async () => {
    let capturedUser = '';
    const provider = makeProvider(
      [
        {
          text: validJudgeJson,
          usage: { tokensIn: 100, tokensOut: 10 },
          model: 'm',
        },
      ],
      (_sys, user) => {
        capturedUser = user;
      },
    );

    const longReport = 'A'.repeat(8000);
    await runJudge(provider, { ...INPUT, reportMarkdown: longReport });

    expect(capturedUser).toContain('[...截断，原文 8000 字]');
    // Original 8k chars must NOT appear in full anywhere in the prompt.
    expect(capturedUser.includes('A'.repeat(8000))).toBe(false);
  });

  it('mentions cross-dim severity when provided', async () => {
    let capturedUser = '';
    const provider = makeProvider(
      [
        {
          text: validJudgeJson,
          usage: { tokensIn: 100, tokensOut: 10 },
          model: 'm',
        },
      ],
      (_s, u) => {
        capturedUser = u;
      },
    );

    await runJudge(provider, { ...INPUT, crossDimSeverity: 'WARNING' });
    expect(capturedUser).toContain('cross-dim validator 严重度');
    expect(capturedUser).toContain('WARNING');
  });
});
