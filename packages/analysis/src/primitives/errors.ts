/**
 * Thrown when a Dimension is registered without all required fields,
 * or when getDimension can't find a registered dimension for the type.
 */
export class InvalidContractError extends Error {
  constructor(
    message: string,
    public readonly missingFields?: string[],
  ) {
    super(message);
    this.name = 'InvalidContractError';
  }
}

/**
 * Signals that a tool invocation exceeded a code-owned safety cap. This is an
 * internal error; Analysis exposes only its normal module/run failure states.
 *
 * Limits:
 *   - 'maxTokens'    — provider/workflow safety cap
 *   - 'maxToolCalls' — ToolMiddlewareConfig per-tool / total call cap
 *   - 'toolBudget'   — optional provider-side cost guard
 */
export class BudgetExhaustedError extends Error {
  constructor(
    message: string,
    public readonly limit:
      | 'maxTokens'
      | 'maxToolCalls'
      | 'toolBudget',
  ) {
    super(message);
    this.name = 'BudgetExhaustedError';
  }
}

/**
 * Thrown when a symbol fails MarketProfile validation or no market
 * profile claims it. CLAUDE.md §3 #18: validate at the package boundary
 * so prompts never see un-normalized user input.
 */
export class InvalidSymbolError extends Error {
  constructor(
    message: string,
    public readonly rawSymbol: string,
    public readonly market?: string,
  ) {
    super(message);
    this.name = 'InvalidSymbolError';
  }
}

/** Thrown when structured output validation fails after one repair pass. */
export class StructuredOutputError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'StructuredOutputError';
  }
}
