import type { ZodSchema } from 'zod';
import { StructuredOutputError } from './errors';
import type { AgentProvider, ProviderUsage } from './provider';

export interface StructuredOutputOptions {
  signal?: AbortSignal;
  maxTokens?: number;
}

export interface StructuredOutputResult<T> {
  data: T;
  // RFC-01: use ProviderUsage so cache + webSearch telemetry flows through
  // to the dimension/section layer without losing fields. callers must read
  // optional fields with `?? 0` to stay tolerant of older provider impls.
  usage: ProviderUsage;
  /** 1 if the first parse succeeded, 2 if a repair pass was needed. */
  llmCalls: number;
  /** Model id used (last call's model when repair runs); undefined if provider didn't surface it. */
  model?: string;
}

/**
 * Generate JSON via provider.complete + zod validate. On the first failure,
 * feed the bad output + zod error back to the LLM and try once more
 * (CLAUDE.md §3 — schema validation + repair). On second failure, throws
 * StructuredOutputError.
 *
 * Usage from both passes is summed so callers see total cost.
 */
export async function structuredOutputWithRepair<T>(
  provider: AgentProvider,
  systemPrompt: string,
  userPrompt: string,
  schema: ZodSchema<T>,
  options: StructuredOutputOptions = {},
): Promise<StructuredOutputResult<T>> {
  const first = await provider.complete(systemPrompt, userPrompt, options);
  const firstParsed = tryParse(first.text, schema);

  if (firstParsed.success) {
    return {
      data: firstParsed.data,
      usage: first.usage ?? { tokensIn: 0, tokensOut: 0 },
      llmCalls: 1,
      model: first.model,
    };
  }

  const repairUser = buildRepairPrompt(userPrompt, first.text, firstParsed.error);
  const second = await provider.complete(systemPrompt, repairUser, options);
  const secondParsed = tryParse(second.text, schema);

  // RFC-01: sum cache + webSearch fields too. Empty values default to 0 so
  // the resulting object can be safely consumed by downstream aggregators
  // without ?? chains on every field.
  const cacheReadTotal =
    (first.usage?.cacheReadInputTokens ?? 0) +
    (second.usage?.cacheReadInputTokens ?? 0);
  const cacheCreateTotal =
    (first.usage?.cacheCreationInputTokens ?? 0) +
    (second.usage?.cacheCreationInputTokens ?? 0);
  const webSearchTotal =
    (first.usage?.webSearchRequests ?? 0) +
    (second.usage?.webSearchRequests ?? 0);
  const totalUsage: ProviderUsage = {
    tokensIn: (first.usage?.tokensIn ?? 0) + (second.usage?.tokensIn ?? 0),
    tokensOut: (first.usage?.tokensOut ?? 0) + (second.usage?.tokensOut ?? 0),
    ...(cacheReadTotal > 0 ? { cacheReadInputTokens: cacheReadTotal } : {}),
    ...(cacheCreateTotal > 0
      ? { cacheCreationInputTokens: cacheCreateTotal }
      : {}),
    ...(webSearchTotal > 0 ? { webSearchRequests: webSearchTotal } : {}),
  };

  if (!secondParsed.success) {
    throw new StructuredOutputError(
      `Structured output failed after one repair pass: ${secondParsed.error}`,
      secondParsed.error,
    );
  }

  return {
    data: secondParsed.data,
    usage: totalUsage,
    llmCalls: 2,
    model: second.model ?? first.model,
  };
}

type ParseOutcome<T> =
  | { success: true; data: T }
  | { success: false; error: string };

function tryParse<T>(raw: string, schema: ZodSchema<T>): ParseOutcome<T> {
  const cleaned = stripJsonFences(raw);

  let json: unknown;
  try {
    json = JSON.parse(cleaned);
  } catch (e) {
    return { success: false, error: `JSON parse failed: ${(e as Error).message}` };
  }

  const result = schema.safeParse(json);
  if (!result.success) {
    return { success: false, error: result.error.message };
  }
  return { success: true, data: result.data };
}

function stripJsonFences(text: string): string {
  return text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim();
}

function buildRepairPrompt(
  originalUser: string,
  badOutput: string,
  error: string,
): string {
  return `${originalUser}

# 上次输出
\`\`\`
${badOutput}
\`\`\`

# 校验错误
${error}

请仅修复上述错误，重新输出**纯 JSON**（不要包含任何代码块标记或解释文字）。`;
}
