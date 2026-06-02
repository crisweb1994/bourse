import { describe, expect, it, vi } from 'vitest';
import { SCHEMA_VERSION } from '../../contracts/analysis-result';
import type { SseEvent } from '../../contracts/sse-events';
import { getDimension } from '../../dimensions';
const FUNDAMENTAL = getDimension('FUNDAMENTAL');
import type { DomainTier } from '../../markets/types';
import type {
  AgentProvider,
  ProviderStreamOptions,
  ProviderStreamResult,
} from '../../primitives/provider';
import { streamDimension } from '../../primitives/stream-dimension';

/**
 * RFC-06 T3 + T4: streamDimension forwards `allowedDomains` to the
 * provider and `domainTiers` to evidence-gate. These tests pin the
 * forwarding shape without exercising the rest of the pipeline.
 */

const URL = 'https://xueqiu.com/post';
const TODAY = '2026-05-10';

/** Structured JSON the fake's `complete()` returns — one citation,
 *  qualityTier 'A', URL matches the stream's citations[] so the policy
 *  check passes. Evidence-gate Rule 0 should downgrade 'A' → 'D' (xueqiu
 *  is mapped to D in the test domainTiers). */
function structuredJsonWithUpgradedTier(): string {
  return JSON.stringify({
    schemaVersion: SCHEMA_VERSION,
    conclusion: {
      signal: 'BULLISH',
      confidence: 'HIGH',
      oneLiner: 'baseline',
      evidence: [],
    },
    evidence: [
      {
        claim: 'over-claimed',
        citations: [
          {
            title: 'S',
            url: URL,
            sourceType: 'NEWS',
            retrievedAt: '2026-05-10T00:00:00Z',
            qualityTier: 'A',
          },
        ],
      },
    ],
    dataAvailability: { missingFields: [], reason: 'ok' },
    dataAsOf: TODAY,
    disclaimer: 'd',
  });
}

function buildProvider(): {
  provider: AgentProvider;
  capturedOptions: { value: ProviderStreamOptions | undefined };
} {
  const capturedOptions: { value: ProviderStreamOptions | undefined } = {
    value: undefined,
  };
  const provider: AgentProvider = {
    name: 'fake',
    stream: vi.fn(
      async (
        _sys: unknown,
        _user: string,
        onChunk: (c: { type: 'text'; text: string }) => void,
        options?: ProviderStreamOptions,
      ): Promise<ProviderStreamResult> => {
        capturedOptions.value = options;
        onChunk({ type: 'text', text: 'body' });
        return {
          text: 'body',
          citations: [
            {
              title: 'S',
              url: URL,
              sourceType: 'OTHER',
              retrievedAt: '2026-05-10T00:00:00Z',
            },
          ],
          usage: { tokensIn: 100, tokensOut: 50 },
        };
      },
    ),
    complete: vi.fn(async () => ({
      text: structuredJsonWithUpgradedTier(),
      usage: { tokensIn: 80, tokensOut: 40 },
    })),
    getModel: () => 'm',
    getUtilityModel: () => 'jm',
  };
  return { provider, capturedOptions };
}

async function collect(
  gen: AsyncGenerator<SseEvent, void, undefined>,
): Promise<SseEvent[]> {
  const out: SseEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

const minimalInput = {
  symbol: 'AAPL',
  market: 'US',
  locale: 'zh-CN' as const,
};
const runId = 'run_rfc06_test';

describe('streamDimension — RFC-06 allowedDomains forwarding', () => {
  it('forwards allowedDomains into provider.stream options', async () => {
    const { provider, capturedOptions } = buildProvider();
    await collect(
      streamDimension(provider, FUNDAMENTAL, minimalInput, {
        runId,
        todayDate: TODAY,
        allowedDomains: ['cninfo.com.cn', 'eastmoney.com'],
      }),
    );
    expect(capturedOptions.value?.allowedDomains).toEqual([
      'cninfo.com.cn',
      'eastmoney.com',
    ]);
  });

  it('omits allowedDomains when option is undefined', async () => {
    const { provider, capturedOptions } = buildProvider();
    await collect(
      streamDimension(provider, FUNDAMENTAL, minimalInput, {
        runId,
        todayDate: TODAY,
      }),
    );
    expect(capturedOptions.value?.allowedDomains).toBeUndefined();
  });

  it('omits allowedDomains when option is an empty array', async () => {
    const { provider, capturedOptions } = buildProvider();
    await collect(
      streamDimension(provider, FUNDAMENTAL, minimalInput, {
        runId,
        todayDate: TODAY,
        allowedDomains: [],
      }),
    );
    expect(capturedOptions.value?.allowedDomains).toBeUndefined();
  });
});

describe('streamDimension — RFC-06 domainTiers feed into evidence-gate', () => {
  it('forces downgrade of LLM-declared qualityTier when host is lower-tier', async () => {
    const tiers: Record<string, DomainTier> = {
      'cninfo.com.cn': 'A',
      'xueqiu.com': 'D',
    };
    const { provider } = buildProvider();
    const events = await collect(
      streamDimension(provider, FUNDAMENTAL, minimalInput, {
        runId,
        todayDate: TODAY,
        domainTiers: tiers,
      }),
    );
    const structured = events.find((e) => e.type === 'structured_data');
    expect(structured?.type).toBe('structured_data');
    if (structured && structured.type === 'structured_data') {
      const cit = (structured.json as {
        evidence: Array<{
          citations: Array<{ qualityTier: string }>;
        }>;
      }).evidence[0]!.citations[0]!;
      expect(cit.qualityTier).toBe('D');
    }
  });

  it('leaves declared tier alone when domainTiers option is omitted', async () => {
    const { provider } = buildProvider();
    const events = await collect(
      streamDimension(provider, FUNDAMENTAL, minimalInput, {
        runId,
        todayDate: TODAY,
      }),
    );
    const structured = events.find((e) => e.type === 'structured_data');
    if (structured && structured.type === 'structured_data') {
      const cit = (structured.json as {
        evidence: Array<{
          citations: Array<{ qualityTier: string }>;
        }>;
      }).evidence[0]!.citations[0]!;
      expect(cit.qualityTier).toBe('A');
    }
  });
});
