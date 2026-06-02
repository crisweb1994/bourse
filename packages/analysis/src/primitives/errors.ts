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
 * Signals that the run hit a budget cap. Caller should expect partial
 * result with status = BUDGET_EXHAUSTED.
 *
 * Limits:
 *   - 'maxTokens'    — workflow-level token cap (BudgetLimits.maxTokens)
 *   - 'maxToolCalls' — ToolMiddlewareConfig per-tool / total call cap
 *   - 'maxCostUsd'   — workflow-level USD cap
 *   - 'toolBudget'   — RFC-09 P2: ToolPolicy.budgetCapUsd per-call USD
 *                      ceiling exceeded after a successful tool run
 */
export class BudgetExhaustedError extends Error {
  constructor(
    message: string,
    public readonly limit:
      | 'maxTokens'
      | 'maxToolCalls'
      | 'maxCostUsd'
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
