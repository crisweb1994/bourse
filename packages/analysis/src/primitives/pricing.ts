/**
 * Per-model pricing for USD cost computation. Rates in USD per million
 * tokens (Anthropic published prices, early 2026).
 *
 * Models not in this table fall back to `DEFAULT_RATES` (Sonnet 4 rates,
 * a sensible mid-tier estimate).
 */
export interface ModelPricing {
  /** USD per 1M input tokens. */
  inputPerMTok: number;
  /** USD per 1M output tokens. */
  outputPerMTok: number;
}

const DEFAULT_RATES: ModelPricing = { inputPerMTok: 3, outputPerMTok: 15 };

const TABLE: Record<string, ModelPricing> = {
  // Claude 4 family (Anthropic public pricing, USD per million tokens)
  'claude-opus-4-20250514': { inputPerMTok: 15, outputPerMTok: 75 },
  'claude-sonnet-4-20250514': { inputPerMTok: 3, outputPerMTok: 15 },
  'claude-haiku-4-5-20251001': { inputPerMTok: 1, outputPerMTok: 5 },
  'claude-opus-4': { inputPerMTok: 15, outputPerMTok: 75 },
  'claude-sonnet-4': { inputPerMTok: 3, outputPerMTok: 15 },
  'claude-haiku-4-5': { inputPerMTok: 1, outputPerMTok: 5 },
  // OpenAI 4.x / 5.x family (best-effort published rates).
  'gpt-4o': { inputPerMTok: 2.5, outputPerMTok: 10 },
  'gpt-4o-mini': { inputPerMTok: 0.15, outputPerMTok: 0.6 },
  'gpt-4.1': { inputPerMTok: 2, outputPerMTok: 8 },
  'gpt-4.1-mini': { inputPerMTok: 0.4, outputPerMTok: 1.6 },
  'gpt-4.1-nano': { inputPerMTok: 0.1, outputPerMTok: 0.4 },
  'gpt-5': { inputPerMTok: 5, outputPerMTok: 20 },
  'gpt-5-mini': { inputPerMTok: 1, outputPerMTok: 4 },
};

export function getPricing(model: string | undefined): ModelPricing {
  if (!model) return DEFAULT_RATES;
  return TABLE[model] ?? DEFAULT_RATES;
}

/**
 * Compute USD cost for a single LLM call given the model and token usage.
 * Returns 0 when usage is undefined.
 */
export function computeUsd(
  model: string | undefined,
  tokensIn: number,
  tokensOut: number,
): number {
  const rates = getPricing(model);
  return (
    (tokensIn / 1_000_000) * rates.inputPerMTok +
    (tokensOut / 1_000_000) * rates.outputPerMTok
  );
}
