import type {
  ProviderCompleteOptions,
  ProviderCompleteResult,
  ProviderStreamChunk,
  ProviderStreamOptions,
  ProviderStreamResult,
  SystemPromptInput,
} from './types';

/**
 * Vendor-neutral LLM provider interface.
 *
 * Implementations wrap a specific SDK (Anthropic / OpenAI / etc.) and translate
 * its native streaming + tool-use surface into our zod-typed Citation + chunk
 * shape. All public outputs MUST conform to types defined in `contracts/`.
 */
/**
 * Static capability declarations a provider advertises after construction.
 * `webSearch.available=true` means *some* web_search path is wired:
 *   - 'native' → Anthropic `web_search_20250305` or OpenAI Responses
 *     `web_search_preview` (provider-internal, no executor involved)
 *   - 'pluggable' → an external `WebSearchExecutor` (e.g. SearXNG/Serper)
 *     mounted into the chat.completions tool-call loop
 * Downstream (stream-dimension, freshness prompt) reads this to decide
 * whether to tell the model "use web_search" or "no tool available".
 */
export interface ProviderCapabilities {
  webSearch: {
    available: boolean;
    source?: 'native' | 'pluggable';
  };
}

export interface AgentProvider {
  readonly name: string;
  /**
   * Optional — when absent, downstream treats `webSearch.available` as
   * true to preserve back-compat. Production providers (claude / openai)
   * declare this so freshness prompt can branch correctly.
   */
  readonly capabilities?: ProviderCapabilities;

  /**
   * Stream a prompt with web_search enabled, surfacing text deltas and
   * citation events as they arrive. Returns the accumulated final state.
   *
   * RFC-04: `systemPrompt` accepts either a plain string (back-compat,
   * uncached) or a SystemTextBlock[] (RFC-04 cache_control supported on
   * Anthropic; flattened to string on OpenAI).
   */
  stream(
    systemPrompt: SystemPromptInput,
    userPrompt: string,
    onChunk: (chunk: ProviderStreamChunk) => void,
    options?: ProviderStreamOptions,
  ): Promise<ProviderStreamResult>;

  /**
   * Single-shot completion without tool use. Used for structured-JSON
   * extraction over an already-generated report.
   *
   * RFC-04: same dual-shape `systemPrompt` as `stream()`.
   */
  complete(
    systemPrompt: SystemPromptInput,
    userPrompt: string,
    options?: ProviderCompleteOptions,
  ): Promise<ProviderCompleteResult>;

  /** Resolve the model id used for `stream` (caller may override). */
  getModel(override?: string): string;

  /** Resolve the cheaper model id used for structured-JSON `complete`. */
  getUtilityModel(override?: string): string;
}
