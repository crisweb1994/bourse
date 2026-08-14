import { SectionResult } from '../contracts/analysis-result';
import { OverallConclusion } from '../contracts/comprehensive-summary';
import type { Citation } from '../contracts/citation';
import type { SseEvent } from '../contracts/sse-events';
import type { AnalysisMode, SectionType } from '../contracts/enums';
import { DEFAULT_DISCLAIMER } from '../primitives/disclaimer';
import {
  buildSectionReports,
  buildSummaryJsonPrompts,
  buildSummaryPrompts,
  ComprehensiveSummaryLenient,
  hydrateSummaryCitations,
  normalizeSummarySignal,
} from '../primitives/summary-prompts';
import { structuredOutputWithRepair } from '../primitives/structured-output';
import { streamDimension } from '../primitives/stream-dimension';
import type { AgentProvider } from '../primitives/provider';
import { ALL_DIMENSIONS } from '../dimensions';
import type { Dimension, DimensionInput, DimensionRunResult } from '../dimensions/types';
import { RESEARCH_PRESETS } from '../presets';
import type { ComprehensiveOptions, ComprehensiveResult, DimensionFailure } from './types';

const FACT_TYPES: readonly SectionType[] = [
  'COMPANY_QUALITY',
  'INDUSTRY_POSITION',
  'VALUATION_SCENARIOS',
  'MARKET_SIGNALS',
];

const REQUIRED_FOR_SIGNAL: readonly SectionType[] = [
  'COMPANY_QUALITY',
  'VALUATION_SCENARIOS',
  'RISK_REGISTER',
];

/**
 * A deliberately small in-process async queue. It lets concurrent provider
 * calls stream events through one async generator without polling timers or
 * introducing a durable job/event subsystem.
 */
class AsyncEventQueue<T> {
  private readonly items: T[] = [];
  private readonly waiters: Array<(value: T | null) => void> = [];
  private closed = false;

  push(item: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter(item);
    else this.items.push(item);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    while (this.waiters.length > 0) this.waiters.shift()!(null);
  }

  next(): Promise<T | null> {
    const item = this.items.shift();
    if (item !== undefined) return Promise.resolve(item);
    if (this.closed) return Promise.resolve(null);
    return new Promise<T | null>((resolve) => this.waiters.push(resolve));
  }
}

/**
 * The Analysis V2 workflow:
 *
 * 1. Emit the immutable evidence pack metadata.
 * 2. Run four independent fact modules in parallel.
 * 3. Run the risk register after those facts are available.
 * 4. Build one conclusion from completed module results, without new search.
 *
 * The workflow owns sequencing and failure semantics. Provider calls remain
 * inside `streamDimension`, so the public surface stays one small generator.
 */
export async function* streamComprehensive(
  provider: AgentProvider,
  input: DimensionInput,
  options: ComprehensiveOptions,
): AsyncGenerator<SseEvent, ComprehensiveResult, undefined> {
  const runId = options.runId;
  let sequence = options.startSeq ?? 0;
  const todayDate = options.todayDate ?? new Date().toISOString().slice(0, 10);
  const mode = options.mode ?? 'QUICK';
  const preset = RESEARCH_PRESETS[mode];
  const dimensions = (options.dimensions ?? ALL_DIMENSIONS).map((dimension) =>
    applyModePreset(dimension, mode),
  );
  const orderByType = new Map(dimensions.map((dimension, index) => [dimension.type, index]));
  const results = new Map<SectionType, DimensionRunResult>(
    (options.existingResults ?? []).map((result) => [result.type, result]),
  );
  const failures: DimensionFailure[] = [];
  const warnings: string[] = [];
  const allCitations: Citation[] = [];
  let tokensIn = 0;
  let tokensOut = 0;
  let llmCalls = 0;
  let toolCalls = 0;
  const startedAt = Date.now();

  const emit = (event: SseEvent): SseEvent => ({
    ...event,
    runId,
    seq: sequence++,
  });

  if (options.evidencePack) {
    yield emit({
      type: 'evidence_pack_ready',
      runId,
      seq: 0,
      pack: options.evidencePack,
    });
  }

  const runWave = (
    waveDimensions: readonly Dimension[],
    waveInput: DimensionInput,
  ) =>
    runDimensionWave(waveDimensions, waveInput, {
      provider,
      runId,
      todayDate,
      signal: options.signal,
      evidencePack: options.evidencePack,
      marketProfile: options.marketProfile,
      maxToolCalls: preset.maxToolCallsPerSection,
      maxConcurrent:
        options.waveMode === 'sequential'
          ? 1
          : Math.max(1, Math.floor(options.waveSemaphore ?? 4)),
      orderByType,
      results,
      failures,
      emitCostUpdate: (usage) => {
        tokensIn += usage.tokensIn;
        tokensOut += usage.tokensOut;
        llmCalls += usage.llmCalls;
        toolCalls += usage.toolCalls;
      },
    });

  const factDimensions = dimensions.filter((dimension) =>
    FACT_TYPES.includes(dimension.type) && !results.has(dimension.type),
  );
  for await (const event of runWave(factDimensions, input)) {
    if (event.type === 'citation') allCitations.push(event.citation);
    if (event.type === 'section_complete' && event.usage) {
      yield emit({
        type: 'cost_update',
        runId,
        seq: 0,
        totalTokens: tokensIn + tokensOut,
        toolCalls,
      });
    }
    yield emit(event);
  }

  if (options.signal?.aborted) {
    const result = buildResult(
      'CANCELLED', results, failures, null, allCitations, warnings,
      tokensIn, tokensOut, llmCalls, toolCalls, startedAt,
    );
    yield emitDone(emit, result);
    return result;
  }

  const risk = dimensions.find(
    (dimension) =>
      dimension.type === 'RISK_REGISTER' && !results.has(dimension.type),
  );
  if (risk) {
    if (results.size === 0) {
      const missing = FACT_TYPES.filter((type) => !results.has(type));
      const skipped = makeSkippedEvents(risk, orderByType.get(risk.type) ?? 0, missing);
      failures.push({ type: risk.type, error: 'Required fact modules did not complete' });
      for (const event of skipped) yield emit(event);
    } else {
      const context = JSON.stringify(
        Array.from(results.values()).map((result) => ({
          type: result.type,
          assessment: result.structuredJson.assessment,
          confidence: result.confidence,
          summary: result.structuredJson.summary,
          findings: result.structuredJson.findings,
        })),
      ).slice(0, 20_000);
      for await (const event of runWave([risk], { ...input, sectionContext: context })) {
        if (event.type === 'citation') allCitations.push(event.citation);
        if (event.type === 'section_complete' && event.usage) {
          yield emit({
            type: 'cost_update',
            runId,
            seq: 0,
            totalTokens: tokensIn + tokensOut,
            toolCalls,
          });
        }
        yield emit(event);
      }
    }
  }

  if (options.signal?.aborted) {
    const result = buildResult(
      'CANCELLED', results, failures, null, allCitations, warnings,
      tokensIn, tokensOut, llmCalls, toolCalls, startedAt,
    );
    yield emitDone(emit, result);
    return result;
  }

  let summary: ComprehensiveResult['summary'] = null;
  if (results.size > 0) {
    const missingRequired = REQUIRED_FOR_SIGNAL.filter((type) => {
      const result = results.get(type);
      return !result || result.structuredJson.assessment === 'UNASSESSABLE';
    });
    const summaryPrompt = buildSummaryPrompts(
      buildSectionReports(results),
      todayDate,
      Array.from(results.keys()),
      failures.map((failure) => failure.type),
      input.question,
      missingRequired,
    );
    try {
      const chunks: string[] = [];
      const stream = await provider.stream(
        summaryPrompt.system,
        summaryPrompt.user,
        (chunk) => {
          if (chunk.type === 'text') chunks.push(chunk.text);
          else allCitations.push(chunk.citation);
        },
        { signal: options.signal, disableTools: true },
      );
      const markdown = stream.text || chunks.join('');
      for (const chunk of chunks) {
        yield emit({
          type: 'summary_chunk',
          runId,
          seq: 0,
          deltaText: chunk,
        });
      }
      tokensIn += stream.usage?.tokensIn ?? 0;
      tokensOut += stream.usage?.tokensOut ?? 0;
      llmCalls += 1;

      const jsonPrompts = buildSummaryJsonPrompts(markdown);
      const parsed = await structuredOutputWithRepair(
        provider,
        jsonPrompts.system,
        jsonPrompts.user,
        ComprehensiveSummaryLenient,
        { signal: options.signal },
      );
      tokensIn += parsed.usage.tokensIn;
      tokensOut += parsed.usage.tokensOut;
      llmCalls += parsed.llmCalls;

      const hydrated = hydrateSummaryCitations(parsed.data, allCitations, todayDate);
      const normalized = normalizeSummarySignal(hydrated, missingRequired);
      summary = {
        markdown,
        structured: { ...normalized, disclaimer: DEFAULT_DISCLAIMER },
      };
      yield emit({
        type: 'summary_complete',
        runId,
        seq: 0,
        fullMarkdown: markdown,
        json: summary.structured,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warnings.push(`综合结论生成失败：${message}`);
      yield emit({
        type: 'error',
        runId,
        seq: 0,
        message,
        recoverable: false,
      });
    }
  }

  const status: ComprehensiveResult['status'] =
    results.size === 0
      ? 'FAILED'
      : summary && failures.length === 0
        ? 'COMPLETED'
        : 'PARTIAL_FAILED';
  const result = buildResult(
    status, results, failures, summary, allCitations, warnings,
    tokensIn, tokensOut, llmCalls, toolCalls, startedAt,
  );
  yield emitDone(emit, result);
  return result;
}

export async function runComprehensive(
  provider: AgentProvider,
  input: DimensionInput,
  options: ComprehensiveOptions,
): Promise<ComprehensiveResult> {
  const generator = streamComprehensive(provider, input, options);
  while (true) {
    const next = await generator.next();
    if (next.done) return next.value;
  }
}

interface WaveContext {
  provider: AgentProvider;
  runId: string;
  todayDate: string;
  signal?: AbortSignal;
  evidencePack?: ComprehensiveOptions['evidencePack'];
  marketProfile?: ComprehensiveOptions['marketProfile'];
  maxToolCalls: number;
  maxConcurrent: number;
  orderByType: ReadonlyMap<SectionType, number>;
  results: Map<SectionType, DimensionRunResult>;
  failures: DimensionFailure[];
  emitCostUpdate: (usage: {
    tokensIn: number;
    tokensOut: number;
    llmCalls: number;
    toolCalls: number;
  }) => void;
}

async function* runDimensionWave(
  dimensions: readonly Dimension[],
  input: DimensionInput,
  ctx: WaveContext,
): AsyncGenerator<SseEvent, void, undefined> {
  if (dimensions.length === 0) return;
  const events = new AsyncEventQueue<SseEvent>();
  let nextIndex = 0;
  const workerCount = Math.min(ctx.maxConcurrent, dimensions.length);

  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = nextIndex++;
      const dimension = dimensions[index];
      if (!dimension) return;
      await runOneDimension(dimension, input, {
        ...ctx,
        order: ctx.orderByType.get(dimension.type) ?? index,
        emit: (event) => events.push(event),
      });
    }
  });
  const allWorkers = Promise.all(workers).finally(() => events.close());

  while (true) {
    const event = await events.next();
    if (event === null) break;
    yield event;
  }
  await allWorkers;
}

interface DimensionContext extends WaveContext {
  order: number;
  emit: (event: SseEvent) => void;
}

async function runOneDimension(
  dimension: Dimension,
  input: DimensionInput,
  ctx: DimensionContext,
): Promise<void> {
  if (ctx.signal?.aborted) return;

  const skip = skipReason(ctx.evidencePack, dimension);
  if (skip) {
    for (const event of makeSkippedEvents(dimension, ctx.order, skip.missingFields, skip.reason)) {
      ctx.emit(event);
    }
    ctx.failures.push({ type: dimension.type, error: skip.reason });
    return;
  }

  let markdown = '';
  let structured: unknown = null;
  const citations: Citation[] = [];
  let usage = { tokensIn: 0, tokensOut: 0 };

  try {
    for await (const event of streamDimension(ctx.provider, dimension, input, {
      runId: ctx.runId,
      order: ctx.order,
      todayDate: ctx.todayDate,
      signal: ctx.signal,
      ...(ctx.evidencePack ? { evidencePack: ctx.evidencePack } : {}),
      ...(ctx.marketProfile?.domainTiers
        ? { domainTiers: ctx.marketProfile.domainTiers }
        : {}),
      maxToolCalls: ctx.maxToolCalls,
    })) {
      if (event.type === 'report_chunk') markdown += event.deltaText;
      if (event.type === 'report_complete') markdown = event.fullMarkdown;
      if (event.type === 'citation') citations.push(event.citation);
      if (event.type === 'structured_data') structured = event.json;
      if (event.type === 'section_complete' && event.usage) {
        usage = {
          tokensIn: event.usage.tokensIn,
          tokensOut: event.usage.tokensOut,
        };
        ctx.emitCostUpdate({
          tokensIn: event.usage.tokensIn,
          tokensOut: event.usage.tokensOut,
          llmCalls: event.usage.llmCalls ?? 0,
          toolCalls: event.usage.toolCalls ?? 0,
        });
      }
      ctx.emit(event);
    }

    const parsed = SectionResult.parse(structured);
    ctx.results.set(dimension.type, {
      type: dimension.type,
      reportMarkdown: markdown,
      structuredJson: parsed,
      citations,
      confidence: parsed.confidence,
      status: 'COMPLETED',
      warnings: [],
      usage,
    });
  } catch (error) {
    if (ctx.signal?.aborted) {
      ctx.emit({
        type: 'section_complete',
        runId: ctx.runId,
        seq: 0,
        sectionType: dimension.type,
        status: 'CANCELLED',
      });
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    ctx.failures.push({ type: dimension.type, error: message });
    ctx.emit({
      type: 'error',
      runId: ctx.runId,
      seq: 0,
      sectionType: dimension.type,
      message,
      recoverable: false,
    });
    ctx.emit({
      type: 'section_complete',
      runId: ctx.runId,
      seq: 0,
      sectionType: dimension.type,
      status: 'FAILED',
    });
  }
}

function skipReason(
  pack: ComprehensiveOptions['evidencePack'],
  dimension: Dimension,
): { reason: 'DEGRADED_SOURCE_MISSING_PRIVATE_DATA' | 'INSUFFICIENT_REQUIRED_FACTS'; missingFields: string[] } | null {
  if (!pack) return null;
  const raw = pack as unknown as {
    researchCoverage?: { dimensions?: Record<string, { skip?: boolean; missingCriticalFacts?: string[] }> };
    dataAvailability?: { degradedSource?: string; missingPrivateFields?: string[] };
  };
  const coverage = raw.researchCoverage?.dimensions?.[dimension.type];
  if (coverage?.skip) {
    return {
      reason: 'INSUFFICIENT_REQUIRED_FACTS',
      missingFields: coverage.missingCriticalFacts ?? [],
    };
  }
  const missingPrivate = raw.dataAvailability?.missingPrivateFields ?? [];
  if (
    raw.dataAvailability?.degradedSource === 'WEB_SEARCH_FALLBACK' &&
    dimension.requiresPrivateData?.some((field) => missingPrivate.includes(field))
  ) {
    return {
      reason: 'DEGRADED_SOURCE_MISSING_PRIVATE_DATA',
      missingFields: dimension.requiresPrivateData.filter((field) => missingPrivate.includes(field)),
    };
  }
  return null;
}

function makeSkippedEvents(
  dimension: Dimension,
  order: number,
  missingFields: string[],
  reason: 'DEGRADED_SOURCE_MISSING_PRIVATE_DATA' | 'INSUFFICIENT_REQUIRED_FACTS' = 'INSUFFICIENT_REQUIRED_FACTS',
): SseEvent[] {
  return [
    {
      type: 'section_start',
      runId: '',
      seq: 0,
      sectionType: dimension.type,
      order,
    },
    {
      type: 'section_skipped',
      runId: '',
      seq: 0,
      sectionType: dimension.type,
      reason,
      missingFields,
    },
    {
      type: 'section_complete',
      runId: '',
      seq: 0,
      sectionType: dimension.type,
      status: 'SKIPPED',
    },
  ];
}

function applyModePreset(dimension: Dimension, mode: AnalysisMode): Dimension {
  if (mode === 'QUICK') return { ...dimension, multiRoundPlan: undefined };
  if (!dimension.multiRoundPlan) return dimension;
  return {
    ...dimension,
    multiRoundPlan: {
      ...dimension.multiRoundPlan,
      perRoundToolUses: RESEARCH_PRESETS[mode].maxToolCallsPerSection,
    },
  };
}

function buildResult(
  status: ComprehensiveResult['status'],
  results: Map<SectionType, DimensionRunResult>,
  failures: DimensionFailure[],
  summary: ComprehensiveResult['summary'],
  citations: Citation[],
  warnings: string[],
  tokensIn: number,
  tokensOut: number,
  llmCalls: number,
  toolCalls: number,
  startedAt: number,
): ComprehensiveResult {
  const partialDimensions = [...new Set(failures.map((failure) => failure.type))];
  return {
    status,
    perDimension: results,
    failures,
    partialDimensions,
    summary,
    citations,
    warnings,
    trace: {
      llmCalls,
      toolCalls,
      tokensIn,
      tokensOut,
      durationMs: Date.now() - startedAt,
      perDimension: Object.fromEntries(
        Array.from(results.entries()).map(([type, result]) => [type, {
          durationMs: 0,
          citationsCount: result.citations.length,
          tokensIn: result.usage.tokensIn,
          tokensOut: result.usage.tokensOut,
          llmCalls: 0,
          toolCalls: 0,
        }]),
      ),
    },
  };
}

function emitDone(
  emit: (event: SseEvent) => SseEvent,
  result: ComprehensiveResult,
): SseEvent {
  return emit({
    type: 'done',
    runId: '',
    seq: 0,
    status: result.status,
    result: {
      reportMarkdown: result.summary?.markdown ?? '',
      structuredJson: result.summary?.structured ?? null,
      citations: result.citations,
      status: result.status,
      confidence: result.summary?.structured.confidence ?? 'LOW',
      trace: result.trace,
      warnings: result.warnings,
      partialSections: result.partialDimensions.length > 0
        ? result.partialDimensions
        : undefined,
    },
  });
}
