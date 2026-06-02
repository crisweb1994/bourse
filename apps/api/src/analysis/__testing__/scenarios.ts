/**
 * v0.3 后遗留 ① Layer 1：5 个 regression scenario。
 *
 * 设计：每个 scenario 是"灌进 adapter 的 SSE 事件序列 + 初始 section/config"。
 * 输出（send/prisma/telemetry/result）由 adapter 决定，被 scenario-runner 捕获
 * 后由 snapshot.diffFixture 与 __fixtures__/<name>.json 比对。
 *
 * 覆盖 Phase A 关心的边界：
 *  1. comprehensive-happy-2dim          —— 基线：2 维全 COMPLETED
 *  2. comprehensive-section-failed      —— FUNDAMENTAL 失败 → PARTIAL_FAILED
 *  3. comprehensive-tavily-disabled     —— provider.capabilities.webSearch=false，
 *                                          无 citation 事件（"UI 选了但 runtime 没有"路径）
 *  4. comprehensive-budget-exhausted    —— done with BUDGET_EXHAUSTED
 *  5. debate-heterogeneous              —— DEBATE workflow + 异构 provider
 */
import type {
  SseEvent,
} from '@bourse/analysis';

import type {
  ScenarioInput,
  ScenarioInputComprehensive,
  TestProviderCapabilities,
} from './scenario-runner';

const RUN_ID = 'fixture-run';
const TODAY_ISO = '2026-05-21T00:00:00.000Z';
const URL_A = 'https://example.com/a';
const URL_B = 'https://example.com/b';

const CAP_WEB_OFF: TestProviderCapabilities = {
  webSearch: { available: false },
};

function evt<T extends SseEvent['type']>(
  type: T,
  rest: Record<string, unknown>,
  seq: number,
): SseEvent {
  return { type, runId: RUN_ID, seq, ...rest } as unknown as SseEvent;
}

function citation(url: string) {
  return {
    title: 'Source',
    url,
    sourceType: 'NEWS' as const,
    retrievedAt: TODAY_ISO,
  };
}

function structuredOk(sectionType: string, signal = 'BULLISH', confidence = 'HIGH') {
  return {
    sectionType,
    json: {
      schemaVersion: 'agent-result-v1',
      conclusion: {
        signal,
        confidence,
        oneLiner: 'fixture conclusion',
        evidence: [],
      },
      evidence: [],
      dataAvailability: { missingFields: [], reason: 'ok' },
      dataAsOf: '2026-05-21',
      disclaimer: 'fixture disclaimer',
    },
  };
}

function usageOk(extra: Record<string, number> = {}) {
  return {
    tokensIn: 100,
    tokensOut: 50,
    llmCalls: 1,
    toolCalls: 2,
    durationMs: 1234,
    citationsCount: 1,
    costUsd: 0.01,
    ...extra,
  };
}

// ===== Scenario 1: comprehensive-happy-2dim =====

const SCEN_HAPPY: ScenarioInputComprehensive = {
  kind: 'comprehensive',
  name: 'comprehensive-happy-2dim',
  sections: [
    { id: 'sec-fund', type: 'FUNDAMENTAL', order: 0, status: 'PENDING' },
    { id: 'sec-val', type: 'VALUATION', order: 1, status: 'PENDING' },
  ],
  events: [
    evt('section_start', { sectionType: 'FUNDAMENTAL', order: 0 }, 1),
    evt('report_chunk', { sectionType: 'FUNDAMENTAL', deltaText: 'hello ' }, 2),
    evt('citation', { sectionType: 'FUNDAMENTAL', citation: citation(URL_A) }, 3),
    evt('report_complete', { sectionType: 'FUNDAMENTAL', fullMarkdown: 'hello world' }, 4),
    evt('structured_data', structuredOk('FUNDAMENTAL', 'BULLISH', 'HIGH'), 5),
    evt('section_complete', {
      sectionType: 'FUNDAMENTAL',
      status: 'COMPLETED',
      usage: usageOk(),
    }, 6),
    evt('section_start', { sectionType: 'VALUATION', order: 1 }, 7),
    evt('report_chunk', { sectionType: 'VALUATION', deltaText: 'val ' }, 8),
    evt('citation', { sectionType: 'VALUATION', citation: citation(URL_B) }, 9),
    evt('report_complete', { sectionType: 'VALUATION', fullMarkdown: 'val report' }, 10),
    evt('structured_data', structuredOk('VALUATION', 'NEUTRAL', 'MEDIUM'), 11),
    evt('section_complete', {
      sectionType: 'VALUATION',
      status: 'COMPLETED',
      usage: usageOk(),
    }, 12),
    evt('summary_chunk', { deltaText: 'summary ' }, 13),
    evt('summary_complete', {
      fullMarkdown: 'summary text',
      json: {
        schemaVersion: 'agent-result-v1',
        overall: { signal: 'BULLISH', confidence: 'HIGH', recommendation: 'BUY' },
        disclaimer: 'fixture',
      },
    }, 14),
    evt('done', { status: 'COMPLETED' }, 15),
  ],
};

// ===== Scenario 2: comprehensive-section-failed =====

const SCEN_FAILED: ScenarioInputComprehensive = {
  kind: 'comprehensive',
  name: 'comprehensive-section-failed',
  sections: [
    { id: 'sec-fund', type: 'FUNDAMENTAL', order: 0, status: 'PENDING' },
    { id: 'sec-val', type: 'VALUATION', order: 1, status: 'PENDING' },
  ],
  events: [
    evt('section_start', { sectionType: 'FUNDAMENTAL', order: 0 }, 1),
    evt('report_chunk', { sectionType: 'FUNDAMENTAL', deltaText: 'partial ' }, 2),
    evt('error', {
      sectionType: 'FUNDAMENTAL',
      message: 'upstream rate-limited',
      recoverable: false,
    }, 3),
    evt('section_complete', {
      sectionType: 'FUNDAMENTAL',
      status: 'FAILED',
      usage: usageOk({ citationsCount: 0 }),
    }, 4),
    evt('section_start', { sectionType: 'VALUATION', order: 1 }, 5),
    evt('report_complete', { sectionType: 'VALUATION', fullMarkdown: 'val' }, 6),
    evt('structured_data', structuredOk('VALUATION'), 7),
    evt('section_complete', {
      sectionType: 'VALUATION',
      status: 'COMPLETED',
      usage: usageOk(),
    }, 8),
    evt('done', { status: 'PARTIAL_FAILED' }, 9),
  ],
};

// ===== Scenario 3: comprehensive-tavily-disabled =====

const SCEN_TAVILY_OFF: ScenarioInputComprehensive = {
  kind: 'comprehensive',
  name: 'comprehensive-tavily-disabled',
  providerCapabilities: CAP_WEB_OFF,
  sections: [
    { id: 'sec-fund', type: 'FUNDAMENTAL', order: 0, status: 'PENDING' },
  ],
  events: [
    evt('section_start', { sectionType: 'FUNDAMENTAL', order: 0 }, 1),
    // No `citation` events — webSearch unavailable path
    evt('report_complete', {
      sectionType: 'FUNDAMENTAL',
      fullMarkdown: 'report without web evidence',
    }, 2),
    // dataAvailability flags the degradation
    evt('structured_data', {
      sectionType: 'FUNDAMENTAL',
      json: {
        schemaVersion: 'agent-result-v1',
        conclusion: {
          signal: 'NEUTRAL',
          confidence: 'LOW',
          oneLiner: 'no web evidence',
          evidence: [],
        },
        evidence: [],
        dataAvailability: {
          missingFields: ['webSearch'],
          reason: 'web_search capability disabled',
        },
        dataAsOf: '2026-05-21',
        disclaimer: 'fixture',
      },
    }, 3),
    evt('section_complete', {
      sectionType: 'FUNDAMENTAL',
      status: 'COMPLETED',
      usage: usageOk({ citationsCount: 0, webSearchRequests: 0 }),
    }, 4),
    evt('done', { status: 'COMPLETED' }, 5),
  ],
};

// ===== Scenario 4: comprehensive-budget-exhausted =====

const SCEN_BUDGET: ScenarioInputComprehensive = {
  kind: 'comprehensive',
  name: 'comprehensive-budget-exhausted',
  sections: [
    { id: 'sec-fund', type: 'FUNDAMENTAL', order: 0, status: 'PENDING' },
    { id: 'sec-val', type: 'VALUATION', order: 1, status: 'PENDING' },
  ],
  events: [
    evt('section_start', { sectionType: 'FUNDAMENTAL', order: 0 }, 1),
    evt('report_complete', { sectionType: 'FUNDAMENTAL', fullMarkdown: 'fund' }, 2),
    evt('structured_data', structuredOk('FUNDAMENTAL'), 3),
    evt('section_complete', {
      sectionType: 'FUNDAMENTAL',
      status: 'COMPLETED',
      usage: usageOk(),
    }, 4),
    // VALUATION never starts — workflow hits budget before dim 2
    evt('done', { status: 'BUDGET_EXHAUSTED' }, 5),
  ],
};

export const SCENARIOS: ScenarioInput[] = [
  SCEN_HAPPY,
  SCEN_FAILED,
  SCEN_TAVILY_OFF,
  SCEN_BUDGET,
];
