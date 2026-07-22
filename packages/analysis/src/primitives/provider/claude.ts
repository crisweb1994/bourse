import Anthropic from '@anthropic-ai/sdk';
import type {
  CitationsDelta,
  ContentBlockParam,
  MessageParam,
  RawMessageStreamEvent,
  ServerToolUseBlock,
  WebSearchToolResultBlock,
  WebSearchToolResultBlockContent,
} from '@anthropic-ai/sdk/resources/messages/messages';
import type { Citation } from '../../contracts/citation';
import type { AgentProvider } from './provider';
import type {
  ProviderCompleteOptions,
  ProviderCompleteResult,
  ProviderStreamChunk,
  ProviderStreamOptions,
  ProviderStreamResult,
  SystemPromptInput,
  WebSearchError,
  WebSearchErrorCode,
} from './types';

/**
 * RFC-04: translate the vendor-neutral SystemPromptInput shape to the
 * Anthropic SDK's `system` parameter. SDK accepts either a string or an
 * array of TextBlockParam (which may carry `cache_control`). We only
 * forward the cache_control hint — anything else is intentionally
 * stripped so downstream providers / cross-vendor callers see a uniform
 * shape.
 */
function toAnthropicSystemParam(
  input: SystemPromptInput,
):
  | string
  | Array<{
      type: 'text';
      text: string;
      cache_control?: { type: 'ephemeral' };
    }> {
  if (typeof input === 'string') return input;
  return input.map((b) => ({
    type: 'text' as const,
    text: b.text,
    ...(b.cacheControl
      ? { cache_control: { type: 'ephemeral' as const } }
      : {}),
  }));
}

// RFC-01: known Anthropic web_search error codes. Any unknown code is mapped
// to 'unavailable' so downstream telemetry never crashes on a new code.
const KNOWN_WEB_SEARCH_ERROR_CODES: ReadonlySet<WebSearchErrorCode> = new Set([
  'too_many_requests',
  'invalid_input',
  'max_uses_exceeded',
  'query_too_long',
  'unavailable',
]);

function normalizeWebSearchErrorCode(raw: string): WebSearchErrorCode {
  return (KNOWN_WEB_SEARCH_ERROR_CODES as Set<string>).has(raw)
    ? (raw as WebSearchErrorCode)
    : 'unavailable';
}

const DEFAULT_MODEL = 'claude-sonnet-4-20250514';
const DEFAULT_UTILITY_MODEL = 'claude-haiku-4-5-20251001';
const DEFAULT_MAX_TOOL_USES = 10;
const DEFAULT_MAX_TOKENS_STREAM = 16000;
const DEFAULT_MAX_TOKENS_COMPLETE = 8000;
const ROUND_SEPARATOR = '\n\n---\n\n';

export interface ClaudeProviderConfig {
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
   * Test-only: inject an Anthropic-compatible client (e.g. a vitest fake).
   * Production code should NOT pass this.
   */
  _internalClient?: Anthropic;
}

interface RoundOutcome {
  text: string;
  /** Assistant content blocks for replay into the next round's messages. */
  assistantContent: ContentBlockParam[];
  usage?: {
    tokensIn: number;
    tokensOut: number;
    // RFC-01: surfaced from finalMessage.usage. Optional + nullable to tolerate
    // SDK versions that don't carry the field yet.
    cacheReadInputTokens?: number;
    cacheCreationInputTokens?: number;
    webSearchRequests?: number;
  };
  toolUseCounts: Record<string, number>;
  /** RFC-01: web_search_tool_result_error blocks detected this round. */
  webSearchErrors: WebSearchError[];
}

export class ClaudeProvider implements AgentProvider {
  readonly name = 'claude';
  readonly capabilities = {
    webSearch: { available: true, source: 'native' as const },
  };
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly utilityModel: string;

  constructor(config: ClaudeProviderConfig) {
    this.client =
      config._internalClient ??
      new Anthropic({
        apiKey: config.apiKey,
        baseURL: config.baseUrl,
      });
    this.model = config.model ?? DEFAULT_MODEL;
    // Falls back to main model when utilityModel isn't configured.
    // Third-party Claude proxies that route to a single underlying model
    // would otherwise 400 on the hard-coded DEFAULT_UTILITY_MODEL.
    this.utilityModel =
      config.utilityModel ?? config.model ?? DEFAULT_UTILITY_MODEL;
  }

  /**
   * Single-round (back-compat) when `options.rounds` is empty/absent.
   * Multi-round (MVP doc §4.2.1) when `options.rounds` has entries: replays
   * each prior assistant turn into the next call's `messages`, letting the
   * model deepen analysis with web_search across turns. Total budget is
   * code-side: rounds × per-round maxToolUses.
   */
  async stream(
    systemPrompt: SystemPromptInput,
    userPrompt: string,
    onChunk: (chunk: ProviderStreamChunk) => void,
    options: ProviderStreamOptions = {},
  ): Promise<ProviderStreamResult> {
    const model = this.getModel(options.model);
    const defaultMaxToolUses = options.maxToolUses ?? DEFAULT_MAX_TOOL_USES;
    const rounds = options.rounds ?? [];
    // Per-call tool disable (used by the summary stage); web_search is
    // otherwise always available.
    const disableTools = options.disableTools === true;
    // RFC-04: SDK system param accepts string or TextBlockParam[]. We
    // build the array form when caller passed SystemTextBlock[]; otherwise
    // we keep the legacy string path. cache_control hints flow through to
    // the SDK; Anthropic ignores them when blocks are below the
    // 1024-token minimum (no error, no cache_creation_input_tokens).
    const apiSystem = toAnthropicSystemParam(systemPrompt);

    const seenUrls = new Set<string>();
    const citations: Citation[] = [];
    const pushCitation = (raw: { title: string | null; url: string }): void => {
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

    const aggregateUsage = {
      tokensIn: 0,
      tokensOut: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      webSearchRequests: 0,
    };
    const aggregateToolUseCounts: Record<string, number> = {};
    const aggregateWebSearchErrors: WebSearchError[] = [];
    let fullText = '';

    // Build the conversation. Round 0 = initial userPrompt; subsequent rounds
    // append the previous assistant turn + a new user turn from
    // options.rounds[i].userPrompt.
    const messages: MessageParam[] = [
      { role: 'user', content: userPrompt },
    ];

    const totalRounds = 1 + rounds.length;
    for (let i = 0; i < totalRounds; i++) {
      // For round i>0, append a user message before this round's stream.
      if (i > 0) {
        const r = rounds[i - 1];
        messages.push({ role: 'user', content: r.userPrompt });
      }

      const roundMaxToolUses =
        i === 0
          ? defaultMaxToolUses
          : rounds[i - 1].maxToolUses ?? defaultMaxToolUses;

      const outcome = await this.runRound({
        model,
        system: apiSystem,
        messages,
        maxToolUses: roundMaxToolUses,
        disableTools,
        round: i + 1, // 1-indexed for telemetry / SSE warning events
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
        aggregateUsage.cacheReadInputTokens +=
          outcome.usage.cacheReadInputTokens ?? 0;
        aggregateUsage.cacheCreationInputTokens +=
          outcome.usage.cacheCreationInputTokens ?? 0;
        aggregateUsage.webSearchRequests +=
          outcome.usage.webSearchRequests ?? 0;
      }
      for (const [name, n] of Object.entries(outcome.toolUseCounts)) {
        aggregateToolUseCounts[name] = (aggregateToolUseCounts[name] ?? 0) + n;
      }
      if (outcome.webSearchErrors.length > 0) {
        aggregateWebSearchErrors.push(...outcome.webSearchErrors);
      }

      // Push the assistant turn back into the conversation so the next round
      // sees prior text + web_search_tool_result blocks.
      messages.push({ role: 'assistant', content: outcome.assistantContent });

      options.onRoundComplete?.(i + 1, outcome.text);

      // Inject visual round separator into the streamed text for the next
      // round's text to be clearly delimited in the final markdown. Only
      // when there IS a next round.
      if (i < totalRounds - 1) {
        fullText += ROUND_SEPARATOR;
        onChunk({ type: 'text', text: ROUND_SEPARATOR });
      }
    }

    return {
      text: fullText,
      citations,
      usage: aggregateUsage.tokensIn + aggregateUsage.tokensOut > 0
        ? {
            tokensIn: aggregateUsage.tokensIn,
            tokensOut: aggregateUsage.tokensOut,
            // RFC-01: omit zero values to keep cost_update events lean and
            // make absence vs zero distinguishable downstream.
            ...(aggregateUsage.cacheReadInputTokens > 0
              ? { cacheReadInputTokens: aggregateUsage.cacheReadInputTokens }
              : {}),
            ...(aggregateUsage.cacheCreationInputTokens > 0
              ? {
                  cacheCreationInputTokens:
                    aggregateUsage.cacheCreationInputTokens,
                }
              : {}),
            ...(aggregateUsage.webSearchRequests > 0
              ? { webSearchRequests: aggregateUsage.webSearchRequests }
              : {}),
          }
        : undefined,
      toolUseCounts: aggregateToolUseCounts,
      model,
      ...(aggregateWebSearchErrors.length > 0
        ? { webSearchErrors: aggregateWebSearchErrors }
        : {}),
    };
  }

  private async runRound(args: {
    model: string;
    /** RFC-04: string for legacy uncached path, TextBlockParam[] for the
     *  cache_control-enabled path. SDK's `messages.stream` accepts both. */
    system: string | Array<{ type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }>;
    messages: MessageParam[];
    maxToolUses: number;
    disableTools: boolean;
    /** 1-indexed round number, used to tag web_search errors for telemetry. */
    round: number;
    /** RFC-06: optional `allowed_domains` for the web_search tool. */
    allowedDomains?: readonly string[];
    onText: (text: string) => void;
    onCitation: (raw: { title: string | null; url: string }) => void;
    signal?: AbortSignal;
  }): Promise<RoundOutcome> {
    let roundText = '';

    const streamParams: Parameters<typeof this.client.messages.stream>[0] = {
      model: args.model,
      max_tokens: DEFAULT_MAX_TOKENS_STREAM,
      system: args.system,
      messages: args.messages,
      ...(args.disableTools
        ? {}
        : {
            tools: [
              {
                type: 'web_search_20250305',
                name: 'web_search',
                max_uses: args.maxToolUses,
                // RFC-06: source-routing — only restrict when caller passed a
                // non-empty list. Empty/undefined → omit field entirely so
                // Anthropic falls back to "any domain" (legacy behavior).
                ...(args.allowedDomains && args.allowedDomains.length > 0
                  ? { allowed_domains: [...args.allowedDomains] }
                  : {}),
              },
            ],
          }),
    };
    const stream = this.client.messages.stream(streamParams, {
      signal: args.signal,
    });

    for await (const event of stream as AsyncIterable<RawMessageStreamEvent>) {
      if (event.type !== 'content_block_delta') continue;
      const { delta } = event;
      if (delta.type === 'text_delta') {
        roundText += delta.text;
        args.onText(delta.text);
      } else if (delta.type === 'citations_delta') {
        const cite = (delta as CitationsDelta).citation;
        if (cite.type === 'web_search_result_location') {
          args.onCitation({ title: cite.title, url: cite.url });
        }
      }
    }

    // Sweep finalMessage for any URLs not surfaced via citations_delta + count
    // server_tool_use blocks for middleware-level cap enforcement.
    const finalMessage = await stream.finalMessage();
    const toolUseCounts: Record<string, number> = {};
    const webSearchErrors: WebSearchError[] = [];
    for (const block of finalMessage.content) {
      if (block.type === 'web_search_tool_result') {
        const toolBlock = block as WebSearchToolResultBlock;
        const content: WebSearchToolResultBlockContent = toolBlock.content;
        if (Array.isArray(content)) {
          for (const sr of content) {
            if (sr.type === 'web_search_result') {
              args.onCitation({ title: sr.title, url: sr.url });
            }
          }
        } else if (
          content &&
          typeof content === 'object' &&
          'type' in content &&
          content.type === 'web_search_tool_result_error'
        ) {
          // RFC-01: Anthropic surfaces web_search failures inside 200 OK
          // responses as a single error content object. Normalize the code,
          // tag with current round, push for aggregation upstream.
          const errorCode =
            'error_code' in content && typeof content.error_code === 'string'
              ? normalizeWebSearchErrorCode(content.error_code)
              : 'unavailable';
          webSearchErrors.push({
            code: errorCode,
            occurredAt: new Date().toISOString(),
            round: args.round,
          });
        }
      }
      if (block.type === 'server_tool_use') {
        const stb = block as ServerToolUseBlock;
        const ourName = stb.name === 'web_search' ? 'webSearch' : stb.name;
        toolUseCounts[ourName] = (toolUseCounts[ourName] ?? 0) + 1;
      }
    }

    // RFC-01: Anthropic usage block carries optional cache + server_tool_use
    // fields. We read them via type-loose access because the SDK types may
    // lag behind the API surface. All branches default to 0/undefined cleanly.
    let usage: RoundOutcome['usage'] = undefined;
    if (finalMessage.usage) {
      const raw = finalMessage.usage as unknown as {
        input_tokens: number;
        output_tokens: number;
        cache_read_input_tokens?: number;
        cache_creation_input_tokens?: number;
        server_tool_use?: { web_search_requests?: number };
      };
      usage = {
        tokensIn: raw.input_tokens,
        tokensOut: raw.output_tokens,
        ...(typeof raw.cache_read_input_tokens === 'number'
          ? { cacheReadInputTokens: raw.cache_read_input_tokens }
          : {}),
        ...(typeof raw.cache_creation_input_tokens === 'number'
          ? { cacheCreationInputTokens: raw.cache_creation_input_tokens }
          : {}),
        ...(typeof raw.server_tool_use?.web_search_requests === 'number'
          ? { webSearchRequests: raw.server_tool_use.web_search_requests }
          : {}),
      };
    }

    // finalMessage.content is ContentBlock[] (response-shape) but is shape-
    // compatible with ContentBlockParam[] for replay; cast at the boundary
    // and keep the rest of the codebase fully typed.
    return {
      text: roundText,
      assistantContent: finalMessage.content as unknown as ContentBlockParam[],
      usage,
      toolUseCounts,
      webSearchErrors,
    };
  }

  async complete(
    systemPrompt: SystemPromptInput,
    userPrompt: string,
    options: ProviderCompleteOptions = {},
  ): Promise<ProviderCompleteResult> {
    const response = await this.client.messages.create(
      {
        model: this.getUtilityModel(options.model),
        max_tokens: options.maxTokens ?? DEFAULT_MAX_TOKENS_COMPLETE,
        system: toAnthropicSystemParam(systemPrompt),
        messages: [{ role: 'user', content: userPrompt }],
      },
      { signal: options.signal },
    );

    let text = '';
    for (const block of response.content) {
      if (block.type === 'text') {
        text += block.text;
      }
    }

    // RFC-01: same type-loose extraction as runRound() for cache + server tool
    // telemetry. We mirror stream()'s "omit zero" policy so the field set is
    // consistent across both paths: presence implies a non-zero measured
    // value, absence covers both "API didn't surface" and "explicitly zero".
    // complete() doesn't currently enable web_search, so webSearchRequests
    // will be 0 in practice; field still kept for symmetry.
    let usage: ProviderCompleteResult['usage'] = undefined;
    if (response.usage) {
      const raw = response.usage as unknown as {
        input_tokens: number;
        output_tokens: number;
        cache_read_input_tokens?: number;
        cache_creation_input_tokens?: number;
        server_tool_use?: { web_search_requests?: number };
      };
      const cacheRead = raw.cache_read_input_tokens ?? 0;
      const cacheCreate = raw.cache_creation_input_tokens ?? 0;
      const webRequests = raw.server_tool_use?.web_search_requests ?? 0;
      usage = {
        tokensIn: raw.input_tokens,
        tokensOut: raw.output_tokens,
        ...(cacheRead > 0 ? { cacheReadInputTokens: cacheRead } : {}),
        ...(cacheCreate > 0 ? { cacheCreationInputTokens: cacheCreate } : {}),
        ...(webRequests > 0 ? { webSearchRequests: webRequests } : {}),
      };
    }

    return { text, usage, model: this.getUtilityModel(options.model) };
  }

  getModel(override?: string): string {
    return override ?? this.model;
  }

  getUtilityModel(override?: string): string {
    return override ?? this.utilityModel;
  }
}
