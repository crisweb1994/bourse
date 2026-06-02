import type { Citation } from '../../contracts/citation';

export type ProviderStreamChunk =
  | { type: 'text'; text: string }
  | { type: 'citation'; citation: Citation };

/**
 * RFC-04: a vendor-neutral system-prompt building block. When passed to
 * `AgentProvider.stream` / `complete` as an array, each block can carry a
 * `cacheControl` hint that Anthropic provider translates to the SDK's
 * `cache_control: { type: 'ephemeral' }`. OpenAI provider flattens the
 * array (joining `text` with `\n`) and silently drops the cache hint —
 * Anthropic-only cache surface; cross-provider neutral by ignoring.
 *
 * Below Anthropic's 1024-token minimum the cache hint is silently
 * unused (no error, but no `cache_creation_input_tokens` either).
 * Telemetry (RFC-01 SectionTrace) exposes whether a hint actually
 * created/read a cache.
 */
export interface SystemTextBlock {
  type: 'text';
  text: string;
  /** Ephemeral cache (Anthropic default: 5-minute TTL). */
  cacheControl?: { type: 'ephemeral' };
}

/**
 * Vendor-neutral system-prompt parameter. Existing callers passing
 * a single string continue to work — providers wrap as a single
 * uncached block internally.
 */
export type SystemPromptInput = string | readonly SystemTextBlock[];

export interface ProviderUsage {
  tokensIn: number;
  tokensOut: number;
  /**
   * RFC-01: prompt caching telemetry. Populated when the provider returns
   * cache_read_input_tokens / cache_creation_input_tokens in its usage block.
   * Phase 3 will start producing non-zero values; until then expect undefined
   * or 0 on Anthropic for runs without cache_control breakpoints.
   */
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  /**
   * RFC-01: number of provider-internal web_search invocations during this
   * call. On Anthropic, sourced from usage.server_tool_use.web_search_requests.
   */
  webSearchRequests?: number;
}

/**
 * RFC-01: Anthropic web_search_tool_result_error codes (see
 * https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool).
 * OpenAI Responses errors map to the closest equivalent (e.g. rate_limit →
 * 'too_many_requests').
 */
export type WebSearchErrorCode =
  | 'too_many_requests'
  | 'invalid_input'
  | 'max_uses_exceeded'
  | 'query_too_long'
  | 'unavailable';

export interface WebSearchError {
  code: WebSearchErrorCode;
  /** ISO 8601 timestamp captured when the provider surfaced the error. */
  occurredAt: string;
  /** Multi-round path: which round (1-indexed) the error happened in. */
  round?: number;
}

export interface ProviderStreamResult {
  text: string;
  citations: Citation[];
  usage?: ProviderUsage;
  /**
   * Counts of server-side tools the provider invoked during streaming
   * (e.g. `{ webSearch: 3 }`). Optional so that fake/legacy providers
   * needn't supply it; treat absent as `{}`. Workflow-level
   * ToolMiddleware reads from here.
   */
  toolUseCounts?: Record<string, number>;
  /** Model id actually billed (used by USD pricing). */
  model?: string;
  /**
   * RFC-01: provider-internal web_search errors surfaced during the call.
   * Anthropic returns these inside a 200 response body as
   * `web_search_tool_result` blocks with
   * `content.type === 'web_search_tool_result_error'`. We accumulate them
   * here so the dimension layer can decide whether to emit a
   * `web_search_warning` SSE event or downgrade confidence.
   */
  webSearchErrors?: WebSearchError[];
}

export interface ProviderCompleteResult {
  text: string;
  usage?: ProviderUsage;
  /** Model id actually billed (used by USD pricing). */
  model?: string;
  /**
   * RFC-01: same semantics as ProviderStreamResult.webSearchErrors. Even the
   * `complete()` JSON path can surface web_search errors when tools are
   * enabled (currently not common but kept for symmetry + future-proofing).
   */
  webSearchErrors?: WebSearchError[];
}

/**
 * One round in a multi-turn tool-use conversation. MVP doc §4.2.1: total
 * rounds, per-round user prompt, and per-round tool cap are ALL code-side
 * constants — the LLM never decides "let me run another round".
 */
export interface ProviderRound {
  /** Code-generated user prompt for this round. */
  userPrompt: string;
  /** Per-round cap on web_search invocations. Defaults to provider's maxToolUses. */
  maxToolUses?: number;
}

export interface ProviderStreamOptions {
  model?: string;
  signal?: AbortSignal;
  /**
   * Single-round path (backwards-compatible). When `rounds` is set, this is
   * used as the per-round default for any round that doesn't specify its own
   * `maxToolUses`.
   */
  maxToolUses?: number;
  /**
   * Multi-round path. When present and non-empty, provider runs N sequential
   * `messages.stream` calls; each call inherits the previous turn's assistant
   * content blocks (text + web_search_tool_result + server_tool_use) so the
   * model can deepen analysis across rounds. Aggregate text uses `\n\n---\n\n`
   * as separator; citations dedupe by URL; usage / tool counts sum.
   *
   * MVP doc §4.2.1 / §4.3.5: every round's user prompt is code-generated.
   */
  rounds?: readonly ProviderRound[];
  /**
   * Called after each round's `messages.stream` resolves (before the next
   * round starts). Receives 1-indexed round number + that round's text.
   * Used by streamDimension to emit a round-separator chunk on SSE.
   */
  onRoundComplete?: (round: number, text: string) => void;
  /**
   * Plan 3 §4.4.1 — when true, provider runs WITHOUT web_search tool
   * spec. Used by debate.ts Bull/Bear/Judge calls, which must only cite
   * EvidencePack.allowedUrls and are explicitly disallowed from doing
   * fresh web searches.
   */
  disableTools?: boolean;
  /**
   * RFC-06: restricts the provider-internal web_search tool to these
   * domains. Anthropic — passed as `web_search_20250305.allowed_domains`
   * (bare hostnames, no scheme/path); OpenAI Responses — passed as
   * `web_search.filters.allowed_domains`. Empty/undefined → no
   * restriction (legacy behavior). Caller derives the list from a market
   * profile's `domainTiers` (typically `A|B|C|D` keys; tier E is
   * intentionally absent so it's excluded by construction).
   */
  allowedDomains?: readonly string[];
}

export interface ProviderCompleteOptions {
  model?: string;
  signal?: AbortSignal;
}
