/**
 * Scenario runner for analysis workflow regression fixtures.
 *
 * Feeds scripted domain events into `runAnalysisWorkflowAdapter`, captures API
 * SSE frames and Prisma writes, then returns a snapshot-friendly object.
 */
import type {
  AgentProvider,
  ComprehensiveOptions,
  DimensionInput,
  SseEvent,
} from '@bourse/analysis';

/**
 * Minimal shape of `provider.capabilities` — mirrors agent's internal
 * `ProviderCapabilities` (not exported from the package barrel). Only
 * fields the adapters / streamDimension actually read are listed.
 */
export interface TestProviderCapabilities {
  webSearch: { available: boolean; source?: 'native' | 'pluggable' };
}

import {
  runAnalysisWorkflowAdapter,
  type AdapterContext,
  type AdapterResult,
} from '../analysis-workflow-adapter';

export interface CapturedSend {
  type: string;
  data: Record<string, unknown>;
}

export interface CapturedPrisma {
  table: 'analysis' | 'analysisSection';
  method: 'update' | 'updateMany';
  /** Subset of args we care about — `where` keys + top-level `data` keys + data.status if present. */
  whereKeys: string[];
  dataKeys: string[];
  dataStatus?: string;
}

export interface ScenarioInputComprehensive {
  kind: 'comprehensive';
  name: string;
  /** Initial AnalysisSection rows (sectionType → DB id). */
  sections: Array<{ id: string; type: string; order: number; status: string }>;
  /** SSE events the fake `streamComprehensive` will yield, in order. */
  events: SseEvent[];
  /** What the streamComprehensive generator returns at the end. */
  finalReturn?: unknown;
  /** If set, the generator throws this after yielding all events. */
  finalThrow?: Error;
  /** Fake provider capabilities, e.g. webSearch.available=false. */
  providerCapabilities?: TestProviderCapabilities;
  market?: 'CN' | 'US' | 'HK' | 'JP' | 'UK';
}

export type ScenarioInput = ScenarioInputComprehensive;

export interface ScenarioSnapshot {
  scenarioName: string;
  kind: 'comprehensive';
  result: AdapterResult;
  sendEvents: CapturedSend[];
  prismaWrites: CapturedPrisma[];
}

export async function runScenario(input: ScenarioInput): Promise<ScenarioSnapshot> {
  return runComprehensive(input);
}

async function runComprehensive(
  input: ScenarioInputComprehensive,
): Promise<ScenarioSnapshot> {
  const sendEvents: CapturedSend[] = [];
  const prismaWrites: CapturedPrisma[] = [];

  const factory = makeFactory<DimensionInput, ComprehensiveOptions>(
    input.events,
    input.finalReturn,
    input.finalThrow,
  );

  const provider = makeProvider(input.providerCapabilities);

  const ctx: AdapterContext = {
    analysisId: 'a-test',
    analysis: {
      id: 'a-test',
      analysisType: 'COMPREHENSIVE',
      sections: input.sections,
      stock: { symbol: 'TEST', market: input.market ?? 'CN', name: 'Test Co.' },
    },
    provider,
    send: (type, data) => {
      sendEvents.push({ type, data: data as Record<string, unknown> });
    },
    prisma: makePrismaStub(prismaWrites),
    modelId: 'fixture-model',
    _streamFactory: factory,
  };

  const result = await runAnalysisWorkflowAdapter(ctx);

  return {
    scenarioName: input.name,
    kind: 'comprehensive',
    result,
    sendEvents,
    prismaWrites,
  };
}

// ===== Stubs =====

function makeFactory<I, O>(
  events: SseEvent[],
  finalReturn: unknown,
  finalThrow?: Error,
): (provider: AgentProvider, input: I, options: O) => AsyncGenerator<SseEvent, unknown, undefined> {
  return (_p, _i, _o) =>
    (async function* () {
      for (const ev of events) yield ev;
      if (finalThrow) throw finalThrow;
      return finalReturn;
    })();
}

function makeProvider(capabilities?: TestProviderCapabilities): AgentProvider {
  const provider: Record<string, unknown> = {
    name: 'fixture-provider',
    stream: () => Promise.reject(new Error('provider.stream() not used in fixture')),
    complete: () => Promise.reject(new Error('provider.complete() not used in fixture')),
    getModel: () => 'fixture-model',
    getUtilityModel: () => 'fixture-utility-model',
  };
  if (capabilities) provider.capabilities = capabilities;
  return provider as unknown as AgentProvider;
}

function makePrismaStub(sink: CapturedPrisma[]): AdapterContext['prisma'] {
  const captureUpdate = (
    table: 'analysis' | 'analysisSection',
    method: 'update' | 'updateMany',
  ) => async (args: unknown) => {
    const a = args as { where?: Record<string, unknown>; data?: Record<string, unknown> };
    sink.push({
      table,
      method,
      whereKeys: a.where ? Object.keys(a.where).sort() : [],
      dataKeys: a.data ? Object.keys(a.data).sort() : [],
      dataStatus: typeof a.data?.status === 'string' ? a.data.status : undefined,
    });
    return method === 'updateMany' ? ({ count: 1 } as never) : ({} as never);
  };

  return {
    analysis: {
      update: captureUpdate('analysis', 'update'),
    },
    analysisSection: {
      update: captureUpdate('analysisSection', 'update'),
      updateMany: captureUpdate('analysisSection', 'updateMany'),
    },
  } as unknown as AdapterContext['prisma'];
}
