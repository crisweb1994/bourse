import { detectMarket, getMarket } from '../markets';
import type { MarketProfile } from '../markets';
import { InvalidSymbolError } from '../primitives/errors';

export interface SymbolGuardResult {
  market: MarketProfile;
  /** Canonical symbol after normalizeSymbol(). */
  normalized: string;
  /** Cross-source identifiers; ready to feed into prompts/tools. */
  providerSymbols: ReturnType<MarketProfile['providerSymbols']>;
}

/**
 * Symbol guardrail (MVP doc §四 + CLAUDE.md §3 #18). Resolves the symbol
 * to a registered MarketProfile, normalizes it, and validates the
 * canonical form. Throws InvalidSymbolError on any failure. Callers
 * should run this BEFORE handing the symbol to LLM prompts.
 *
 * @param rawSymbol raw user input (mixed case, missing zero-pads, etc.)
 * @param marketHint optional explicit market code; when omitted, the
 *   guard tries every registered profile and picks the first match
 */
export function enforceSymbol(
  rawSymbol: string,
  marketHint?: string,
): SymbolGuardResult {
  if (!rawSymbol || !rawSymbol.trim()) {
    throw new InvalidSymbolError('Empty symbol', rawSymbol, marketHint);
  }

  let market: MarketProfile | undefined;
  if (marketHint) {
    market = getMarket(marketHint);
    if (!market) {
      throw new InvalidSymbolError(
        `Unknown market hint "${marketHint}"`,
        rawSymbol,
        marketHint,
      );
    }
  } else {
    market = detectMarket(rawSymbol);
    if (!market) {
      throw new InvalidSymbolError(
        `No market profile claims symbol "${rawSymbol}"; pass an explicit market hint`,
        rawSymbol,
      );
    }
  }

  const normalized = market.normalizeSymbol(rawSymbol);
  if (!market.validateSymbol(normalized)) {
    throw new InvalidSymbolError(
      `Symbol "${rawSymbol}" (normalized: "${normalized}") fails ${market.code} validation`,
      rawSymbol,
      market.code,
    );
  }

  return {
    market,
    normalized,
    providerSymbols: market.providerSymbols(normalized),
  };
}
