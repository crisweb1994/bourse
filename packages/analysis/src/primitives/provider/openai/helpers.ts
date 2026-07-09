/**
 * Shared helpers used by both the Responses API route and the Chat
 * Completions route of the OpenAI provider. Vendor-neutral (no SDK types),
 * so they can live outside the route files.
 */
import type {
  ProviderCompleteOptions,
  ProviderCompleteResult,
  ProviderStreamChunk,
  ProviderStreamOptions,
  ProviderStreamResult,
  SystemPromptInput,
} from '../types';

/**
 * Contract both OpenAI routes implement so the orchestrator (OpenAIProvider)
 * can delegate `stream`/`complete` without caring which endpoint is in use.
 * Lives here (not in either route file) so neither route depends on the other.
 */
export interface OpenAIRoute {
  stream(
    systemPrompt: SystemPromptInput,
    userPrompt: string,
    onChunk: (chunk: ProviderStreamChunk) => void,
    options: ProviderStreamOptions,
  ): Promise<ProviderStreamResult>;
  complete(
    systemPrompt: SystemPromptInput,
    userPrompt: string,
    options: ProviderCompleteOptions,
  ): Promise<ProviderCompleteResult>;
}

/**
 * RFC-04: OpenAI Responses API doesn't surface Anthropic-style
 * cache_control; flatten SystemTextBlock[] back to a single string by
 * joining `text` with newline. cache hints are silently dropped — the
 * provider's own prompt_cache_retention mechanism is left to a separate
 * RFC. Existing string callers see no change.
 */
export function flattenSystem(input: SystemPromptInput): string {
  if (typeof input === 'string') return input;
  return input.map((b) => b.text).join('\n');
}

/** Separator injected between assistant turns in multi-round provider calls. */
export const ROUND_SEPARATOR = '\n\n---\n\n';

/**
 * Extract {title?, url} pairs from free text by scanning for Markdown links
 * first (preserving their title), then bare URLs.
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
