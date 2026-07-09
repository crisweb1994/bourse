import OpenAI from 'openai';
import {
  buildAdapterFromEnv,
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
import { extractUrlsFromText } from './openai/helpers';
import { OpenAIResponsesRoute } from './openai/responses-route';
import { OpenAIChatCompletionsRoute } from './openai/chat-completions-route';

// Re-export so the public surface (`./openai`) still exports
// extractUrlsFromText — the test file imports it from here directly.
export { extractUrlsFromText };

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

const DEFAULT_MODEL = 'gpt-5.5';
const DEFAULT_UTILITY_MODEL = 'gpt-5.5-mini';

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
  /** Responses API (/v1/responses) delegate — native web_search path. */
  private readonly responsesRoute: OpenAIResponsesRoute;
  /** Chat Completions (/v1/chat/completions) delegate — pluggable web_search path. */
  private readonly chatCompletionsRoute: OpenAIChatCompletionsRoute;

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
    this.responsesRoute = new OpenAIResponsesRoute(
      this.client,
      (override) => this.getModel(override),
      (override) => this.getUtilityModel(override),
    );
    this.chatCompletionsRoute = new OpenAIChatCompletionsRoute(
      this.client,
      this.webSearchExecutorFactory,
      (override) => this.getModel(override),
      (override) => this.getUtilityModel(override),
    );

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
      return this.chatCompletionsRoute.stream(
        systemPrompt,
        userPrompt,
        onChunk,
        options,
      );
    }
    return this.responsesRoute.stream(
      systemPrompt,
      userPrompt,
      onChunk,
      options,
    );
  }

  async complete(
    systemPrompt: SystemPromptInput,
    userPrompt: string,
    options: ProviderCompleteOptions = {},
  ): Promise<ProviderCompleteResult> {
    // Hotfix (2026-05-16): see stream() for OPENAI_USE_CHAT_COMPLETIONS rationale.
    const useChatCompletions = this.resolveUseChatCompletions();
    if (useChatCompletions) {
      return this.chatCompletionsRoute.complete(
        systemPrompt,
        userPrompt,
        options,
      );
    }
    return this.responsesRoute.complete(systemPrompt, userPrompt, options);
  }

  getModel(override?: string): string {
    return override ?? this.model;
  }

  getUtilityModel(override?: string): string {
    return override ?? this.utilityModel;
  }
}
