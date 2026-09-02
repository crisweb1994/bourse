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
