/**
 * plan-v2 Wave 2 — per-dimension fact projection.
 *
 * Each dimension picks the subset of `StockSnapshot` it actually needs.
 * Per plan-v2 §7.2 we deliberately do NOT do this declaratively (no
 * DIMENSION_FACT_SPECS table) — 9 maintained functions are easier to
 * read and modify than 9 entries in a registry.
 */

import type { StockSnapshot } from './types';

export interface DimensionFactView {
  /** Subset of snapshot.rawFacts the dimension is allowed to see. */
  rawFacts: Partial<StockSnapshot['rawFacts']>;
  /** Subset of snapshot.computedFacts. */
  computedFacts: Partial<StockSnapshot['computedFacts']>;
  /** Whether to surface the webSearch slot to the dimension prompt. */
  needsWebSearch: boolean;
  /** Whether to surface macro to the dimension prompt. */
  needsMacro: boolean;
}

// ----------------------------------------------------------------------------
// Per-dimension projections
// ----------------------------------------------------------------------------

export function projectForCompanyQuality(s: StockSnapshot): DimensionFactView {
  return {
    rawFacts: {
      quote: s.rawFacts.quote,
      financials: s.rawFacts.financials,
      profile: s.rawFacts.profile,
    },
    computedFacts: {
      financialRatios: s.computedFacts.financialRatios,
      redFlags: s.computedFacts.redFlags,
    },
    needsWebSearch: false,
    needsMacro: false,
  };
}

export function projectForValuationScenarios(s: StockSnapshot): DimensionFactView {
  return {
    rawFacts: {
      quote: s.rawFacts.quote,
      financials: s.rawFacts.financials,
      consensusEps: s.rawFacts.consensusEps,
    },
    computedFacts: {
      financialRatios: s.computedFacts.financialRatios,
      valuation: s.computedFacts.valuation,
      peerComparison: s.computedFacts.peerComparison,
      historicalContext: s.computedFacts.historicalContext,
    },
    needsWebSearch: true,
    needsMacro: false,
  };
}

export function projectForMarketSignals(s: StockSnapshot): DimensionFactView {
  return {
    rawFacts: {
      quote: s.rawFacts.quote,
      history: s.rawFacts.history,
    },
    computedFacts: {
      technicalIndicators: s.computedFacts.technicalIndicators,
    },
    needsWebSearch: false,
    needsMacro: false,
  };
}

export function projectForRiskRegister(s: StockSnapshot): DimensionFactView {
  return {
    rawFacts: {
      quote: s.rawFacts.quote,
      financials: s.rawFacts.financials,
      filings: s.rawFacts.filings,
    },
    computedFacts: {
      financialRatios: s.computedFacts.financialRatios,
      redFlags: s.computedFacts.redFlags,
    },
    needsWebSearch: true,
    needsMacro: false,
  };
}

export function projectForIndustryPosition(s: StockSnapshot): DimensionFactView {
  return {
    rawFacts: {
      profile: s.rawFacts.profile,
      filings: s.rawFacts.filings,
    },
    computedFacts: {},
    needsWebSearch: true,
    needsMacro: false,
  };
}

// ----------------------------------------------------------------------------
// Registry — dispatch by fixed SectionType name
// ----------------------------------------------------------------------------

export type DimensionName =
  | 'COMPANY_QUALITY'
  | 'INDUSTRY_POSITION'
  | 'VALUATION_SCENARIOS'
  | 'RISK_REGISTER'
  | 'MARKET_SIGNALS';

export function projectForDimension(
  name: DimensionName,
  snapshot: StockSnapshot,
): DimensionFactView {
  switch (name) {
    case 'COMPANY_QUALITY':
      return projectForCompanyQuality(snapshot);
    case 'INDUSTRY_POSITION':
      return projectForIndustryPosition(snapshot);
    case 'VALUATION_SCENARIOS':
      return projectForValuationScenarios(snapshot);
    case 'RISK_REGISTER':
      return projectForRiskRegister(snapshot);
    case 'MARKET_SIGNALS':
      return projectForMarketSignals(snapshot);
    default: {
      const _exhaustive: never = name;
      void _exhaustive;
      throw new Error(`projectForDimension: unknown dimension ${String(name)}`);
    }
  }
}
