import OpenAI from 'openai';
import type { Citation } from '../../contracts/citation';
import {
  buildAdapterFromEnv,
  HallucinationFilter,
  WEB_SEARCH_FUNCTION_SCHEMA,
  WebSearchExecutor,
  type WebSearchExecutorConfig,
} from '../../tools/web-search';
import type { AgentProvider, ProviderCapabilities } from './provider';
import type {
  ProviderCompleteOptions,
  ProviderCompleteResult,
  ProviderStreamChunk,
  ProviderStreamOptions,
  ProviderStreamResult,
  SystemPromptInput,
} from './types';

/**
 * RFC-04: OpenAI Responses API doesn't surface Anthropic-style
 * cache_control; flatten SystemTextBlock[] back to a single string by
 * joining `text` with newline. cache hints are silently dropped — the
 * provider's own prompt_cache_retention mechanism is left to a separate
 * RFC. Existing string callers see no change.
 */
function flattenSystem(input: SystemPromptInput): string {
  if (typeof input === 'string') return input;
  return input.map((b) => b.text).join('\n');
}

/**
 * Default executor factory — builds a per-stream `WebSearchExecutor` from
 * env (Phase 1) when an adapter is configured, else returns null.
 * Each call yields a fresh executor so cache + budget are per-stream.
 */
function defaultWebSearchExecutorFactory(): WebSearchExecutor | null {
  const built = buildAdapterFromEnv();
  if (!built) return null;
  const cfg: WebSearchExecutorConfig = {
    adapter: built.adapter,
    timeoutMs: built.config.timeoutMs,
    budgetUsdPerRun: built.config.budgetPerRunUsd,
    cacheTtlMs: built.config.cacheTtlMs,
  };
  return new WebSearchExecutor(cfg);
}

/** Max tool-call iterations per chat.completions stream — guards against
 *  the model looping forever on web_search. Each iteration is one
 *  upstream HTTP request. */
const CHAT_COMPLETIONS_MAX_TOOL_ROUNDS = 6;

const DEFAULT_MODEL = 'gpt-5.5';
const DEFAULT_UTILITY_MODEL = 'gpt-5.5-mini';
const ROUND_SEPARATOR = '\n\n---\n\n';

export interface OpenAIProviderConfig {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  /**
   * 次模型 (utility). Used for structured JSON extraction/repair,
   * COMPREHENSIVE summary and search query rewriting. Falls back to `model`
   * when unset. web_search + evidence normalization still go through `model`.
   */
  utilityModel?: string;
  /**
   * Optional override for the pluggable web-search factory. When the
   * chat.completions path runs and this returns a non-null executor,
   * the provider injects a `web_search` function tool and handles the
   * tool-call loop. Defaults to `buildAdapterFromEnv()` reading
   * WEB_SEARCH_PROVIDER / SEARXNG_BASE_URL / etc.
   *
   * Pass `() => null` to force-disable pluggable search (e.g. from tests).
   */
  webSearchExecutorFactory?: () => WebSearchExecutor | null;
  /**
   * Force the provider to use the chat.completions endpoint instead of the
   * Responses API, regardless of `OPENAI_USE_CHAT_COMPLETIONS` env. Used by
   * the per-user web-search config flow (CUSTOM_ONLY mode): when the user
   * opts to use their own adapter, we need the pluggable tool-call path,
   * which only exists on chat.completions.
   *
   * `undefined` → respect env (default behavior unchanged).
   * `true` → force chat.completions.
   * `false` → force Responses API (used by env-overrides path; rarely needed).
   */
  forceChatCompletions?: boolean;
  /** Test-only: inject an OpenAI-compatible client. */
  _internalClient?: OpenAI;
}

// ===== Minimal local types for bits OpenAI SDK doesn't fully expose =====
// (responses API tool typing is loose in SDK v6; we narrow the bits we touch.)

interface UrlCitation {
  url?: string;
  title?: string;
}

interface AnnotationLike {
  url_citation?: UrlCitation;
  type?: string;
  url?: string;
  title?: string;
}

interface ResponseStreamEvent {
  type: string;
  delta?: string;
  annotation?: AnnotationLike;
}

interface OutputContent {
  type?: string;
  text?: string;
}

interface OutputItem {
  content?: OutputContent[];
}

interface FinalResponse {
  output_text?: string;
  output?: OutputItem[];
}

interface InputMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface RoundOutcome {
  text: string;
  usage?: { tokensIn: number; tokensOut: number };
  toolUseCount: number;
}

export class OpenAIProvider implements AgentProvider {
  readonly name = 'openai';
  readonly capabilities: ProviderCapabilities;
  private readonly client: OpenAI;
  private readonly model: string;
  private readonly utilityModel: string;
  /** Echo of config.baseUrl for diag logs only — SDK owns the real value. */
  private readonly baseUrl?: string;
  /** Factory for the per-stream pluggable web-search executor. */
  private readonly webSearchExecutorFactory: () => WebSearchExecutor | null;
  /** Per-instance override of the chat.completions routing decision. See OpenAIProviderConfig.forceChatCompletions. */
  private readonly forceChatCompletions?: boolean;
  /** Process-wide one-time env diag (see stream() for usage). */
  private static _loggedEnvFlag = false;

  constructor(config: OpenAIProviderConfig) {
    this.client =
      config._internalClient ??
      new OpenAI({
        apiKey: config.apiKey,
        baseURL: config.baseUrl,
      });
    this.model = config.model ?? DEFAULT_MODEL;
    // Falls back to the main `model` when utilityModel isn't configured.
    // Third-party OpenAI-compatible vendors (DeepSeek / 小米 / Qwen) often
    // route a single model id; pinning DEFAULT_UTILITY_MODEL='gpt-5.5-mini'
    // unconditionally would 400 on the structured-output pass. Users on
    // OpenAI direct can still split (model='gpt-5.5' + utilityModel='gpt-5.5-mini').
    this.utilityModel =
      config.utilityModel ?? config.model ?? DEFAULT_UTILITY_MODEL;
    this.baseUrl = config.baseUrl;
    this.webSearchExecutorFactory =
      config.webSearchExecutorFactory ?? defaultWebSearchExecutorFactory;
    this.forceChatCompletions = config.forceChatCompletions;

    // Capability advertisement: chat.completions path is 'pluggable' only
    // when env has a wired adapter; Responses API path is always 'native'.
    // We sample the factory once at construction — fine for Phase 1 where
    // env is fixed at process start. Phase 2 (DB-driven config) will need
    // a dynamic resolver.
    const useChatCompletions = this.resolveUseChatCompletions();
    if (useChatCompletions) {
      const probe = this.webSearchExecutorFactory();
      this.capabilities = {
        webSearch: probe
          ? { available: true, source: 'pluggable' }
          : { available: false },
      };
    } else {
      this.capabilities = {
        webSearch: { available: true, source: 'native' },
      };
    }
  }

  /**
   * Decide whether to route this call via /v1/chat/completions instead of
   * /v1/responses. Precedence: instance override (`forceChatCompletions`)
   * → env (`OPENAI_USE_CHAT_COMPLETIONS`). Returning `true` enables the
   * pluggable web_search tool path (only chat.completions accepts a
   * custom-shaped `function` tool).
   */
  private resolveUseChatCompletions(): boolean {
    if (typeof this.forceChatCompletions === 'boolean') {
      return this.forceChatCompletions;
    }
    return (
      typeof process !== 'undefined' &&
      process.env?.OPENAI_USE_CHAT_COMPLETIONS === 'true'
    );
  }

  /**
   * Single-round (back-compat) when `options.rounds` is empty/absent.
   * Multi-round (MVP doc §4.2.1) when set: each subsequent round's input
   * inherits prior assistant text, letting the model deepen analysis.
   * OpenAI Responses API doesn't expose web_search internals in a portable
   * way, so we replay assistant text only (sufficient for the model to know
   * "what it said last round" and decide new queries).
   */
  async stream(
    systemPrompt: SystemPromptInput,
    userPrompt: string,
    onChunk: (chunk: ProviderStreamChunk) => void,
    options: ProviderStreamOptions = {},
  ): Promise<ProviderStreamResult> {
    // Hotfix (2026-05-16): OPENAI_USE_CHAT_COMPLETIONS=true routes via the
    // legacy /v1/chat/completions endpoint. The Responses API (/v1/responses)
    // is OpenAI-only — DeepSeek, Qwen/通义, Kimi, 文心 and the rest of the
    // "OpenAI-compatible" 国产 model providers only implement chat.completions
    // and return 404 (no body) on /v1/responses. Tool-use (web_search_preview)
    // is dropped on this path — those vendors don't implement it either.
    //
    // Per-user web-search config (plan-v2 §17.4.4) also forces this path
    // when primaryMode=CUSTOM_ONLY (chat.completions is the only OpenAI
    // path that accepts a pluggable web_search tool function).
    const useChatCompletions = this.resolveUseChatCompletions();
    if (!OpenAIProvider._loggedEnvFlag) {
      const rawChatFlag =
        typeof process !== 'undefined'
          ? process.env?.OPENAI_USE_CHAT_COMPLETIONS
          : undefined;
      // eslint-disable-next-line no-console
      console.warn(
        `[OpenAIProvider] OPENAI_USE_CHAT_COMPLETIONS raw=${JSON.stringify(rawChatFlag)} forceChatCompletions=${JSON.stringify(this.forceChatCompletions)} effective=${useChatCompletions} baseUrl=${JSON.stringify(this.baseUrl)}`,
      );
      OpenAIProvider._loggedEnvFlag = true;
    }
    if (useChatCompletions) {
      return this.streamChatCompletions(
        systemPrompt,
        userPrompt,
        onChunk,
        options,
      );
    }

    const model = this.getModel(options.model);
    const rounds = options.rounds ?? [];
    const disableTools = options.disableTools === true;
    // RFC-04: OpenAI Responses API has its own (different) cache key
    // mechanism; we don't translate Anthropic cache_control to it here.
    // Cross-vendor calls just collapse SystemTextBlock[] to a single
    // string — cache hints silently ignored.
    const systemString = flattenSystem(systemPrompt);

    const seenUrls = new Set<string>();
    const citations: Citation[] = [];
    const pushCitation = (raw: { title?: string; url: string }): void => {
      if (seenUrls.has(raw.url)) return;
      const citation: Citation = {
        title: raw.title ?? raw.url,
        url: raw.url,
        sourceType: 'OTHER',
        retrievedAt: new Date().toISOString(),
      };
      seenUrls.add(raw.url);
      citations.push(citation);
      onChunk({ type: 'citation', citation });
    };

    const aggregateUsage = { tokensIn: 0, tokensOut: 0 };
    let aggregateToolUseCount = 0;
    let fullText = '';

    const messages: InputMessage[] = [
      { role: 'system', content: systemString },
      { role: 'user', content: userPrompt },
    ];

    const totalRounds = 1 + rounds.length;
    for (let i = 0; i < totalRounds; i++) {
      if (i > 0) {
        messages.push({ role: 'user', content: rounds[i - 1].userPrompt });
      }

      const outcome = await this.runRound({
        model,
        messages,
        disableTools,
        allowedDomains: options.allowedDomains,
        onText: (text) => {
          fullText += text;
          onChunk({ type: 'text', text });
        },
        onCitation: pushCitation,
        signal: options.signal,
      });

      if (outcome.usage) {
        aggregateUsage.tokensIn += outcome.usage.tokensIn;
        aggregateUsage.tokensOut += outcome.usage.tokensOut;
      }
      aggregateToolUseCount += outcome.toolUseCount;

      messages.push({ role: 'assistant', content: outcome.text });
      options.onRoundComplete?.(i + 1, outcome.text);

      if (i < totalRounds - 1) {
        fullText += ROUND_SEPARATOR;
        onChunk({ type: 'text', text: ROUND_SEPARATOR });
      }
    }

    // Citation-stripping proxy fallback: mine URLs out of the assistant text
    // so allowedUrls is populated even when annotations are absent
    // (CLAUDE.md §3 #17 — citation enforcement stays code-side).
    if (citations.length === 0 && fullText) {
      for (const u of extractUrlsFromText(fullText)) {
        pushCitation(u);
      }
    }

    return {
      text: fullText,
      citations,
      usage:
        aggregateUsage.tokensIn + aggregateUsage.tokensOut > 0
          ? aggregateUsage
          : undefined,
      toolUseCounts:
        aggregateToolUseCount > 0
          ? { webSearch: aggregateToolUseCount }
          : {},
      model,
    };
  }

  private async runRound(args: {
    model: string;
    messages: InputMessage[];
    disableTools: boolean;
    /** RFC-06: optional `filters.allowed_domains` for the web_search tool. */
    allowedDomains?: readonly string[];
    onText: (text: string) => void;
    onCitation: (raw: { title?: string; url: string }) => void;
    signal?: AbortSignal;
  }): Promise<RoundOutcome> {
    let roundText = '';
    let toolUseCount = 0;

    const params = {
      model: args.model,
      input: args.messages,
      ...(args.disableTools
        ? {}
        : {
            tools: [
              {
                type: 'web_search',
                search_context_size: 'high',
                user_location: { type: 'approximate', country: 'US' },
                // RFC-06: source-routing — only restrict when caller passed a
                // non-empty list. Empty/undefined → omit field entirely so
                // OpenAI falls back to "any domain" (legacy behavior).
                ...(args.allowedDomains && args.allowedDomains.length > 0
                  ? { filters: { allowed_domains: [...args.allowedDomains] } }
                  : {}),
              },
            ],
            tool_choice: { type: 'web_search' },
          }),
    } as unknown as Parameters<typeof this.client.responses.stream>[0];

    const stream = await this.client.responses.stream(params, {
      signal: args.signal,
    });

    for await (const raw of stream as unknown as AsyncIterable<ResponseStreamEvent>) {
      if (raw.type === 'response.output_text.delta' && raw.delta) {
        roundText += raw.delta;
        args.onText(raw.delta);
      } else if (
        raw.type === 'response.output_text.annotation.added' &&
        raw.annotation
      ) {
        const cite = extractCitation(raw.annotation);
        if (cite) args.onCitation(cite);
      } else if (raw.type === 'response.web_search_call.in_progress') {
        toolUseCount += 1;
      }
    }

    const finalResponse = (await (
      stream as unknown as { finalResponse: () => Promise<FinalResponse> }
    ).finalResponse()) ?? {};

    sweepCitations(finalResponse.output, args.onCitation);

    if (!roundText && finalResponse.output_text) {
      roundText = finalResponse.output_text;
      // We never streamed text earlier; emit it now so SSE consumers see it.
      args.onText(finalResponse.output_text);
    }

    const usage = extractUsage(finalResponse);

    return {
      text: roundText,
      usage,
      toolUseCount,
    };
  }

  async complete(
    systemPrompt: SystemPromptInput,
    userPrompt: string,
    options: ProviderCompleteOptions = {},
  ): Promise<ProviderCompleteResult> {
    // Hotfix (2026-05-16): see stream() for OPENAI_USE_CHAT_COMPLETIONS rationale.
    const useChatCompletions = this.resolveUseChatCompletions();
    if (useChatCompletions) {
      return this.completeChatCompletions(systemPrompt, userPrompt, options);
    }

    const params = {
      model: this.getUtilityModel(options.model),
      input: [
        { role: 'system', content: flattenSystem(systemPrompt) },
        { role: 'user', content: userPrompt },
      ],
    } as unknown as Parameters<typeof this.client.responses.create>[0];

    const response = (await this.client.responses.create(params, {
      signal: options.signal,
    })) as unknown as FinalResponse;

    const text = extractOutputText(response);
    const usage = extractUsage(response);

    return {
      text,
      usage,
      model: this.getUtilityModel(options.model),
    };
  }

  /**
   * Hotfix (2026-05-16) — legacy /v1/chat/completions stream path for
   * "OpenAI-compatible" third-party models (DeepSeek / Qwen / Kimi / 文心).
   *
   * RFC 2026-05-16 (pluggable web search): when a `WebSearchExecutor` is
   * wired, this path:
   *   1. injects the `web_search` function tool into request params
   *   2. accumulates streamed `tool_calls[i].function.arguments` JSON
   *      until each call is complete
   *   3. dispatches each call to the executor, appends the result as
   *      `role:'tool'` and starts a follow-up request
   *   4. loops up to CHAT_COMPLETIONS_MAX_TOOL_ROUNDS, then bails
   *   5. runs a `HallucinationFilter` over every emitted text delta so
   *      stray `<function>` / `<invoke>` / `{thoughts:…}` bytes never
   *      reach the SSE stream — defense in depth on top of the prompt
   *      branch in `freshness.ts`.
   *
   * SystemTextBlock[] is flattened to a single string (chat.completions
   * has no cache_control surface).
   */
  private async streamChatCompletions(
    systemPrompt: SystemPromptInput,
    userPrompt: string,
    onChunk: (chunk: ProviderStreamChunk) => void,
    options: ProviderStreamOptions = {},
  ): Promise<ProviderStreamResult> {
    const model = this.getModel(options.model);
    const systemString = flattenSystem(systemPrompt);

    const executor =
      options.disableTools === true ? null : this.webSearchExecutorFactory();

    type ChatMessage =
      | { role: 'system' | 'user'; content: string }
      | {
          role: 'assistant';
          content: string | null;
          /** DeepSeek thinking-mode extension (RFC: hotfix 2026-05-19). */
          reasoning_content?: string;
          tool_calls?: Array<{
            id: string;
            type: 'function';
            function: { name: string; arguments: string };
          }>;
        }
      | { role: 'tool'; tool_call_id: string; content: string };

    const messages: ChatMessage[] = [
      { role: 'system', content: systemString },
      { role: 'user', content: userPrompt },
    ];

    const aggregateUsage = { tokensIn: 0, tokensOut: 0 };
    const filter = new HallucinationFilter();
    let fullText = '';
    const citations: Citation[] = [];
    const seenUrls = new Set<string>();
    const toolUseCounts: Record<string, number> = {};

    const pushCitation = (c: Citation): void => {
      if (seenUrls.has(c.url)) return;
      seenUrls.add(c.url);
      citations.push(c);
      onChunk({ type: 'citation', citation: c });
    };

    const emitText = (delta: string): void => {
      const clean = filter.feed(delta);
      if (clean) {
        fullText += clean;
        onChunk({ type: 'text', text: clean });
      }
    };

    for (let round = 0; round < CHAT_COMPLETIONS_MAX_TOOL_ROUNDS; round += 1) {
      // Hotfix (2026-05-19): DeepSeek thinking models (V4-Pro / reasoner) can
      // loop in tool calls forever — every round emits reasoning_content +
      // new tool_calls, never `content`. After the final round the loop
      // breaks with empty fullText and downstream sees a blank report. Force
      // the LLM to stop searching and write the final answer on the LAST
      // round by stripping tools and adding a system message.
      const isLastRound = round === CHAT_COMPLETIONS_MAX_TOOL_ROUNDS - 1;
      if (isLastRound && executor && round > 0) {
        messages.push({
          role: 'user',
          content:
            '(系统提示) 搜索轮次已达上限。**不要再调用 web_search**，请基于已有信息直接给出完整的最终分析答案 (markdown 格式)。',
        });
      }

      const params: Record<string, unknown> = {
        model,
        messages,
        stream: true,
      };
      if (executor && !isLastRound) {
        params.tools = [WEB_SEARCH_FUNCTION_SCHEMA];
        params.tool_choice = 'auto';
      }
      if (process.env?.OPENAI_CHAT_STREAM_USAGE === 'true') {
        params.stream_options = { include_usage: true };
      }

      const stream = await this.client.chat.completions.create(
        params as unknown as Parameters<typeof this.client.chat.completions.create>[0],
        { signal: options.signal },
      );

      // Accumulate this round's assistant message: text + (possibly) tool_calls.
      // chat.completions streams tool_calls as sparse deltas: each chunk
      // carries `{index, id?, function:{name?, arguments?(partial JSON)}}`.
      let roundText = '';
      // Hotfix (2026-05-19): DeepSeek thinking mode (deepseek-reasoner /
      // V4-Pro thinking) streams `delta.reasoning_content` alongside
      // `delta.content`. Multi-turn requires the original reasoning_content
      // be passed back in the assistant message, otherwise: 400 "The
      // reasoning_content in the thinking mode must be passed back to the
      // API." Capture here even when we don't emit it as text.
      let roundReasoning = '';
      const toolCallAcc: Map<
        number,
        { id: string; name: string; arguments: string }
      > = new Map();
      let finishReason: string | null = null;

      for await (const chunk of stream as AsyncIterable<{
        choices?: Array<{
          delta?: {
            content?: string;
            reasoning_content?: string;
            tool_calls?: Array<{
              index: number;
              id?: string;
              type?: string;
              function?: { name?: string; arguments?: string };
            }>;
          };
          finish_reason?: string | null;
        }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      }>) {
        const choice = chunk.choices?.[0];
        const delta = choice?.delta;
        if (delta?.content) {
          roundText += delta.content;
          emitText(delta.content);
        }
        if (delta?.reasoning_content) {
          roundReasoning += delta.reasoning_content;
        }
        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            const existing = toolCallAcc.get(tc.index) ?? {
              id: '',
              name: '',
              arguments: '',
            };
            if (tc.id) existing.id = tc.id;
            if (tc.function?.name) existing.name = tc.function.name;
            if (tc.function?.arguments) {
              existing.arguments += tc.function.arguments;
            }
            toolCallAcc.set(tc.index, existing);
          }
        }
        if (choice?.finish_reason) {
          finishReason = choice.finish_reason;
        }
        if (chunk.usage) {
          aggregateUsage.tokensIn += chunk.usage.prompt_tokens ?? 0;
          aggregateUsage.tokensOut += chunk.usage.completion_tokens ?? 0;
        }
      }

      const toolCalls = Array.from(toolCallAcc.values()).filter(
        (c) => c.id && c.name,
      );

      // No more tool calls — flush filter tail and exit loop.
      if (toolCalls.length === 0 || !executor) {
        const tail = filter.flush();
        if (tail) {
          fullText += tail;
          onChunk({ type: 'text', text: tail });
        }
        break;
      }

      // Record the assistant turn (with tool_calls) and execute each call.
      messages.push({
        role: 'assistant',
        content: roundText || null,
        ...(roundReasoning ? { reasoning_content: roundReasoning } : {}),
        tool_calls: toolCalls.map((c) => ({
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: c.arguments },
        })),
      });

      for (const call of toolCalls) {
        if (call.name !== 'web_search') {
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: JSON.stringify({ error: `unknown tool: ${call.name}` }),
          });
          continue;
        }

        let parsed: { query?: unknown; freshnessDays?: unknown } = {};
        try {
          parsed = JSON.parse(call.arguments || '{}');
        } catch {
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: JSON.stringify({ error: 'invalid JSON arguments' }),
          });
          continue;
        }

        const queryStr =
          typeof parsed.query === 'string' ? parsed.query.trim() : '';
        if (!queryStr) {
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: JSON.stringify({ error: 'missing query' }),
          });
          continue;
        }

        const freshnessDays =
          typeof parsed.freshnessDays === 'number'
            ? parsed.freshnessDays
            : undefined;
        const searchStartedAt = Date.now();
        try {
          const result = await executor.execute(
            { query: queryStr, freshnessDays },
            options.signal,
          );
          toolUseCounts.webSearch = (toolUseCounts.webSearch ?? 0) + 1;
          for (const c of result.output.citations) pushCitation(c);
          // Diag (2026-05-19): print every web_search invocation + outcome
          // so dev triage knows what the model was asking about.
          const itemCount = result.output.results?.items?.length ?? 0;
          const durationMs = Date.now() - searchStartedAt;
          if (process.env.LOG_WEB_SEARCH) {
            // eslint-disable-next-line no-console
            console.log(
              `[OpenAIProvider] web_search round=${round} #${toolUseCounts.webSearch} ` +
                `· q=${JSON.stringify(queryStr)}` +
                (freshnessDays ? ` · ${freshnessDays}d` : '') +
                ` · ${itemCount} hits · ${durationMs}ms` +
                (result.error ? ` · ERROR ${result.error.code}` : '') +
                (result.budgetExhausted ? ' · BUDGET_EXHAUSTED' : ''),
            );
          }
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: result.error
              ? JSON.stringify({
                  error: result.error.message,
                  items: [],
                })
              : result.output.text,
          });
          if (result.budgetExhausted) {
            // Tell the model no more searches available.
            messages.push({
              role: 'user',
              content:
                '(系统提示) 网络搜索预算已用尽，请基于现有信息完成分析，不要再请求 web_search。',
            });
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const durationMs = Date.now() - searchStartedAt;
          // eslint-disable-next-line no-console
          console.warn(
            `[OpenAIProvider] web_search round=${round} ` +
              `· q=${JSON.stringify(queryStr)} · THROWN after ${durationMs}ms · ${msg}`,
          );
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: JSON.stringify({ error: msg, items: [] }),
          });
        }
      }

      if (finishReason === 'stop') {
        const tail = filter.flush();
        if (tail) {
          fullText += tail;
          onChunk({ type: 'text', text: tail });
        }
        break;
      }
    }

    // Fallback citation mining for free-text URLs the model may type out
    // (matches the pre-RFC behavior; harmless when executor already
    // provided citations since pushCitation dedupes by URL).
    for (const c of extractUrlsFromText(fullText)) {
      pushCitation({
        title: c.title ?? c.url,
        url: c.url,
        sourceType: 'OTHER',
        retrievedAt: new Date().toISOString(),
      });
    }

    // Hotfix (2026-05-19): when LLM stream returns empty text the
    // downstream structuredOutputWithRepair sees a blank report and the
    // structured-extraction LLM writes literal fallback prose like "分析
    // 报告未提供任何内容". Surface this loudly so triage doesn't have to
    // dig through DB. Typical causes on DeepSeek thinking models:
    //   - model only emitted reasoning_content (no content)
    //   - tool_call iteration consumed budget without any final content turn
    //   - max_tokens hit during thinking phase
    if (!fullText.trim()) {
      // eslint-disable-next-line no-console
      console.warn(
        `[OpenAIProvider] streamChatCompletions returned EMPTY text · ` +
          `model=${model} · tokens=in/${aggregateUsage.tokensIn}/out/${aggregateUsage.tokensOut} · ` +
          `toolCalls=${toolUseCounts.webSearch ?? 0} · ` +
          `likely cause: thinking-mode model only emitted reasoning_content, no final content. ` +
          `Mitigation: switch model to non-reasoner, disable thinking, or unset WEB_SEARCH_PROVIDER.`,
      );
    }

    return {
      text: fullText,
      citations,
      usage:
        aggregateUsage.tokensIn + aggregateUsage.tokensOut > 0
          ? aggregateUsage
          : undefined,
      toolUseCounts,
      model,
    };
  }

  /**
   * Hotfix (2026-05-16) — legacy /v1/chat/completions non-stream path with
   * forced JSON output mode (`response_format: json_object`) so structured
   * output stays compatible with structuredOutputWithRepair.
   */
  private async completeChatCompletions(
    systemPrompt: SystemPromptInput,
    userPrompt: string,
    options: ProviderCompleteOptions = {},
  ): Promise<ProviderCompleteResult> {
    const model = this.getUtilityModel(options.model);
    // Hotfix (2026-05-16): minimal request body — see streamChatCompletions
    // for the 400 Param Incorrect motivation. `response_format` is OpenAI
    // 2024 feature, many compat APIs reject it. Without it the LLM may
    // wrap output in ```json fences, but structuredOutputWithRepair's
    // stripJsonFences handles that. Opt-in via env when vendor is known
    // to support strict JSON mode.
    const completeParams: Record<string, unknown> = {
      model,
      messages: [
        { role: 'system', content: flattenSystem(systemPrompt) },
        { role: 'user', content: userPrompt },
      ],
    };
    if (process.env?.OPENAI_CHAT_RESPONSE_FORMAT === 'true') {
      completeParams.response_format = { type: 'json_object' };
    }
    const response = (await this.client.chat.completions.create(
      completeParams as unknown as Parameters<typeof this.client.chat.completions.create>[0],
      { signal: options.signal },
    )) as unknown as {
      choices: Array<{ message: { content: string | null } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };

    const text = response.choices?.[0]?.message?.content ?? '';
    const usage =
      response.usage &&
      (response.usage.prompt_tokens ?? 0) +
        (response.usage.completion_tokens ?? 0) >
        0
        ? {
            tokensIn: response.usage.prompt_tokens ?? 0,
            tokensOut: response.usage.completion_tokens ?? 0,
          }
        : undefined;

    return { text, usage, model };
  }

  getModel(override?: string): string {
    return override ?? this.model;
  }

  getUtilityModel(override?: string): string {
    return override ?? this.utilityModel;
  }
}

function extractCitation(
  annotation: AnnotationLike,
): { title?: string; url: string } | null {
  if (!annotation || typeof annotation !== 'object') return null;
  if (annotation.url_citation?.url) {
    return {
      title: annotation.url_citation.title,
      url: annotation.url_citation.url,
    };
  }
  if (
    (annotation.type === 'url_citation' || annotation.url) &&
    annotation.url
  ) {
    return { title: annotation.title, url: annotation.url };
  }
  return null;
}

function sweepCitations(
  output: OutputItem[] | undefined,
  push: (raw: { title?: string; url: string }) => void,
): void {
  if (!output) return;
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    const cite = extractCitation(value as AnnotationLike);
    if (cite) push(cite);
    if (Array.isArray(value)) {
      for (const child of value) visit(child);
      return;
    }
    for (const child of Object.values(value as Record<string, unknown>)) {
      visit(child);
    }
  };
  visit(output);
}

function extractOutputText(response: FinalResponse): string {
  if (typeof response?.output_text === 'string') return response.output_text;
  const parts: string[] = [];
  for (const item of response?.output ?? []) {
    for (const content of item?.content ?? []) {
      if (content?.type === 'output_text' && typeof content.text === 'string') {
        parts.push(content.text);
      }
    }
  }
  return parts.join('');
}

/**
 * Mine a markdown/plain-text blob for URLs. Markdown `[title](url)` links
 * are preferred (we keep the title); remaining bare `https://...` URLs are
 * picked up afterwards. Trailing punctuation that's usually a sentence
 * terminator (not part of the URL) is stripped. Deduped by URL.
 *
 * Exported so the openai provider can use it as a fallback when an
 * upstream proxy strips url_citation annotations from web_search output.
 */
export function extractUrlsFromText(
  text: string,
): Array<{ title?: string; url: string }> {
  const seen = new Set<string>();
  const out: Array<{ title?: string; url: string }> = [];

  const MD_LINK = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = MD_LINK.exec(text)) !== null) {
    const url = stripTrailingPunct(m[2]);
    if (!seen.has(url)) {
      seen.add(url);
      out.push({ title: m[1].trim(), url });
    }
  }

  const BARE_URL = /https?:\/\/[^\s<>"'\[\]()]+/g;
  while ((m = BARE_URL.exec(text)) !== null) {
    const url = stripTrailingPunct(m[0]);
    if (!seen.has(url)) {
      seen.add(url);
      out.push({ url });
    }
  }

  return out;
}

function stripTrailingPunct(url: string): string {
  return url.replace(/[.,;:!?)\]}'"]+$/, '');
}

function extractUsage(
  response: unknown,
): { tokensIn: number; tokensOut: number } | undefined {
  if (!response || typeof response !== 'object') return undefined;
  const u = (response as { usage?: { input_tokens?: number; output_tokens?: number } })
    .usage;
  if (!u) return undefined;
  return {
    tokensIn: u.input_tokens ?? 0,
    tokensOut: u.output_tokens ?? 0,
  };
}
