/**
 * OpenAI Responses API (/v1/responses) route — the native web_search path
 * for OpenAI direct. Handles multi-round assistant replay, url_citation
 * annotation streaming, and finalResponse citation sweep.
 *
 * Extracted from openai.ts; behavior is identical to the pre-split code.
 */
import type OpenAI from 'openai';
import type { Citation } from '../../../contracts/citation';
import type {
  ProviderCompleteOptions,
  ProviderCompleteResult,
  ProviderStreamChunk,
  ProviderStreamOptions,
  ProviderStreamResult,
  SystemPromptInput,
} from '../types';
import {
  extractUrlsFromText,
  flattenSystem,
  ROUND_SEPARATOR,
  type OpenAIRoute,
} from './helpers';

interface UrlCitation {
  title?: string;
  url: string;
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

export class OpenAIResponsesRoute implements OpenAIRoute {
  constructor(
    private readonly client: OpenAI,
    private readonly getModel: (override?: string) => string,
    private readonly getUtilityModel: (override?: string) => string,
  ) {}

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
