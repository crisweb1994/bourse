import type { ToolDescriptor } from '../types';

/**
 * Anthropic-side web_search tool. We don't invoke it ourselves — the
 * Claude SDK does, server-side, when the model decides to call it.
 * Registering it here so middleware (Day 11d/e) can reason about its
 * usage by name and enforce caps via ProviderStreamOptions.maxToolUses.
 */
export const webSearch: ToolDescriptor = {
  name: 'webSearch',
  description:
    'Provider-internal web search. Invoked server-side by Claude during stream(); ' +
    'caps and observability go through ToolMiddleware + maxToolUses option.',
  providerInternal: true,
};
