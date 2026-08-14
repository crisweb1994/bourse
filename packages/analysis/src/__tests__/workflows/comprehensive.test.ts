import { describe, expect, it } from 'vitest';
import type {
  AgentProvider,
  ProviderStreamOptions,
  ProviderStreamResult,
} from '../../primitives/provider';
import { ALL_DIMENSIONS } from '../../dimensions';
import { runComprehensive, streamComprehensive } from '../../workflows/comprehensive';
import type { SseEvent } from '../../contracts/sse-events';

const input = {
  symbol: 'AAPL',
  market: 'US',
  locale: 'zh-CN',
  focusWindow: '90D' as const,
};

const summaryJson = {
  headline: '综合看法中性',
  signal: null,
  confidence: 'MEDIUM',
  rationale: [],
  counterpoints: [],
  changeConditions: [],
  missingSections: [],
  dataAsOf: '2026-01-15',
  disclaimer: '免责声明',
};

function sectionJson(type: string): Record<string, unknown> {
  const assessment: Record<string, string> = {
    COMPANY_QUALITY: 'MIXED',
    INDUSTRY_POSITION: 'COMPETITIVE',
    VALUATION_SCENARIOS: 'FAIR',
    RISK_REGISTER: 'MEDIUM',
    MARKET_SIGNALS: 'NEUTRAL',
  };
  return {
    schemaVersion: 'analysis-section-v2',
    type,
    assessment: assessment[type],
    confidence: 'MEDIUM',
    summary: `${type} summary`,
    findings: [],
    limitations: [],
    dataAsOf: '2026-01-15',
    disclaimer: '免责声明',
  };
}

function sectionTypeFromPrompt(prompt: string): string | null {
  return ALL_DIMENSIONS.find((dimension) => prompt.includes(dimension.type))?.type ??
    (prompt.includes('公司质量') ? 'COMPANY_QUALITY' :
      prompt.includes('行业与竞争') ? 'INDUSTRY_POSITION' :
        prompt.includes('估值与情景') ? 'VALUATION_SCENARIOS' :
          prompt.includes('风险清单') ? 'RISK_REGISTER' :
            prompt.includes('市场信号') ? 'MARKET_SIGNALS' : null);
}

function fakeProvider(options: {
  failTypes?: readonly string[];
  failSummary?: boolean;
  streamOptions?: ProviderStreamOptions[];
} = {}): AgentProvider {
  const streamOptions = options.streamOptions ?? [];
  return {
    name: 'fake',
    stream: async (system, user, _onChunk, streamOption) => {
      const systemText = typeof system === 'string' ? system : system.map((block) => block.text).join('\n');
      const isSummary = systemText.includes('综合研究结论整理器');
      if (isSummary && options.failSummary) throw new Error('summary stream failed');
      const type = sectionTypeFromPrompt(`${systemText}\n${user}`);
      streamOptions.push(streamOption ?? {});
      if (type && options.failTypes?.includes(type)) throw new Error(`${type} failed`);
      return {
        text: type ? `report for ${type}` : 'summary markdown',
        citations: [],
        usage: { tokensIn: 10, tokensOut: 5 },
      } satisfies ProviderStreamResult;
    },
    complete: async (system) => {
      const systemText = typeof system === 'string' ? system : system.map((block) => block.text).join('\n');
      if (systemText.includes('综合研究结论整理器')) {
        if (options.failSummary) {
          throw new Error('summary complete failed');
        }
        return {
          text: JSON.stringify(summaryJson),
          usage: { tokensIn: 4, tokensOut: 3 },
        };
      }
      if (options.failSummary && systemText.includes('综合研究结论整理器')) {
        throw new Error('summary complete failed');
      }
      const type = sectionTypeFromPrompt(systemText);
      return {
        text: JSON.stringify(type ? sectionJson(type) : summaryJson),
        usage: { tokensIn: 4, tokensOut: 3 },
      };
    },
    getModel: () => 'model',
    getUtilityModel: () => 'utility',
  };
}

async function collect(gen: AsyncGenerator<SseEvent, unknown, undefined>) {
  const events: SseEvent[] = [];
  let result: unknown;
  while (true) {
    const next = await gen.next();
    if (next.done) {
      result = next.value;
      break;
    }
    events.push(next.value);
  }
  return { events, result: result as any };
}

describe('streamComprehensive V2', () => {
  it('runs four fact modules, then risk, then one summary', async () => {
    const { events, result } = await collect(streamComprehensive(
      fakeProvider(), input, { runId: 'run-1', mode: 'QUICK', focusWindow: '90D' },
    ));
    expect(result.status).toBe('COMPLETED');
    expect([...result.perDimension.keys()]).toEqual([
      'COMPANY_QUALITY', 'INDUSTRY_POSITION', 'VALUATION_SCENARIOS',
      'MARKET_SIGNALS', 'RISK_REGISTER',
    ]);
    expect(events.filter((event) => event.type === 'section_start')).toHaveLength(5);
    expect(events.at(-1)).toMatchObject({ type: 'done', status: 'COMPLETED' });
    expect(result.summary?.structured.headline).toBe('综合看法中性');
  });

  it('uses one round for QUICK and follow-up rounds for DEEP', async () => {
    const quickOptions: ProviderStreamOptions[] = [];
    await runComprehensive(fakeProvider({ streamOptions: quickOptions }), input, {
      runId: 'quick', mode: 'QUICK', dimensions: [ALL_DIMENSIONS[0]!],
    });
    expect(quickOptions.some((option) => option.rounds?.length)).toBe(false);

    const deepOptions: ProviderStreamOptions[] = [];
    await runComprehensive(fakeProvider({ streamOptions: deepOptions }), input, {
      runId: 'deep', mode: 'DEEP', dimensions: [ALL_DIMENSIONS[0]!],
    });
    expect(deepOptions.some((option) => option.rounds?.length === 1)).toBe(true);
  });

  it('does not rerun completed results supplied by a retry', async () => {
    const existing = {
      type: 'COMPANY_QUALITY' as const,
      reportMarkdown: 'prior company quality report',
      structuredJson: sectionJson('COMPANY_QUALITY') as never,
      citations: [],
      confidence: 'MEDIUM' as const,
      status: 'COMPLETED' as const,
      warnings: [],
      usage: { tokensIn: 0, tokensOut: 0 },
    };
    const { events, result } = await collect(streamComprehensive(
      fakeProvider(),
      input,
      { runId: 'retry', mode: 'QUICK', existingResults: [existing] },
    ));

    expect(events.filter((event) => event.type === 'section_start'))
      .not.toContainEqual(expect.objectContaining({ sectionType: 'COMPANY_QUALITY' }));
    expect(result.perDimension.has('COMPANY_QUALITY')).toBe(true);
    expect(result.status).toBe('COMPLETED');
  });

  it('continues with a partial report when one fact module fails', async () => {
    const { result } = await runAndResult({ failTypes: ['INDUSTRY_POSITION'] });
    expect(result.status).toBe('PARTIAL_FAILED');
    expect(result.perDimension.has('COMPANY_QUALITY')).toBe(true);
    expect(result.perDimension.has('INDUSTRY_POSITION')).toBe(false);
    expect(result.perDimension.has('RISK_REGISTER')).toBe(true);
    expect(result.failures).toEqual([expect.objectContaining({ type: 'INDUSTRY_POSITION' })]);
  });

  it('does not create a summary when every fact module fails', async () => {
    const { result } = await runAndResult({
      failTypes: ['COMPANY_QUALITY', 'INDUSTRY_POSITION', 'VALUATION_SCENARIOS', 'MARKET_SIGNALS'],
    });
    expect(result.status).toBe('FAILED');
    expect(result.summary).toBeNull();
    expect(result.failures.map((failure: { type: string }) => failure.type)).toContain('RISK_REGISTER');
  });

  it('keeps completed modules when summary generation fails', async () => {
    const { result } = await runAndResult({ failSummary: true });
    expect(result.status).toBe('PARTIAL_FAILED');
    expect(result.perDimension.size).toBe(5);
    expect(result.summary).toBeNull();
    expect(result.warnings[0]).toContain('综合结论生成失败');
  });

  it('returns CANCELLED before starting modules when aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const { result, events } = await collect(streamComprehensive(
      fakeProvider(), input, { runId: 'cancelled', signal: controller.signal },
    ));
    expect(result.status).toBe('CANCELLED');
    expect(events.at(-1)).toMatchObject({ type: 'done', status: 'CANCELLED' });
  });

  it('skips a module when the immutable pack marks its required facts missing', async () => {
    const { result, events } = await collect(streamComprehensive(
      fakeProvider(), input, {
        runId: 'skip',
        dimensions: [ALL_DIMENSIONS.find((d) => d.type === 'MARKET_SIGNALS')!],
        evidencePack: {
          schemaVersion: 'evidence-pack-v2',
          researchCoverage: {
            dimensions: {
              MARKET_SIGNALS: { skip: true, missingCriticalFacts: ['history'] },
            },
          },
        } as never,
      },
    ));
    expect(result.status).toBe('FAILED');
    expect(events.find((event) => event.type === 'section_skipped')).toMatchObject({
      sectionType: 'MARKET_SIGNALS',
      missingFields: ['history'],
    });
  });
});

async function runAndResult(options: Parameters<typeof fakeProvider>[0]) {
  return runComprehensive(fakeProvider(options), input, {
    runId: 'run-test',
    mode: 'QUICK',
  }).then((result) => ({ result }));
}
