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

export function projectForFundamental(s: StockSnapshot): DimensionFactView {
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

export function projectForValuation(s: StockSnapshot): DimensionFactView {
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

export function projectForTechnical(s: StockSnapshot): DimensionFactView {
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

export function projectForRisk(s: StockSnapshot): DimensionFactView {
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

export function projectForSentiment(s: StockSnapshot): DimensionFactView {
  return {
    rawFacts: {
      quote: s.rawFacts.quote,
      consensusEps: s.rawFacts.consensusEps,
      lhb: s.rawFacts.lhb,
      northboundFlow: s.rawFacts.northboundFlow,
    },
    computedFacts: {},
    needsWebSearch: true,
    needsMacro: false,
  };
}

export function projectForGovernance(s: StockSnapshot): DimensionFactView {
  return {
    rawFacts: {
      filings: s.rawFacts.filings,
      profile: s.rawFacts.profile,
      shareholders: s.rawFacts.shareholders,
    },
    computedFacts: {
      redFlags: s.computedFacts.redFlags,
    },
    needsWebSearch: true,
    needsMacro: false,
  };
}

export function projectForIndustry(s: StockSnapshot): DimensionFactView {
  return {
    rawFacts: {
      profile: s.rawFacts.profile,
    },
    computedFacts: {},
    needsWebSearch: true, // INDUSTRY is primarily web-search driven
    needsMacro: false,
  };
}

export function projectForScenario(s: StockSnapshot): DimensionFactView {
  return {
    rawFacts: {
      quote: s.rawFacts.quote,
      financials: s.rawFacts.financials,
    },
    computedFacts: {
      financialRatios: s.computedFacts.financialRatios,
      valuation: s.computedFacts.valuation,
    },
    needsWebSearch: true,
    needsMacro: true, // SCENARIO uses FRED macro for US
  };
}

export function projectForPortfolio(s: StockSnapshot): DimensionFactView {
  return {
    rawFacts: {
      quote: s.rawFacts.quote,
      history: s.rawFacts.history,
    },
    computedFacts: {
      technicalIndicators: s.computedFacts.technicalIndicators,
      peerComparison: s.computedFacts.peerComparison,
    },
    needsWebSearch: false,
    needsMacro: false,
  };
}

// ----------------------------------------------------------------------------
// Registry — dispatch by AnalysisType name
// ----------------------------------------------------------------------------

export type DimensionName =
  | 'FUNDAMENTAL'
  | 'VALUATION'
  | 'TECHNICAL'
  | 'RISK'
  | 'SENTIMENT'
  | 'GOVERNANCE'
  | 'INDUSTRY'
  | 'SCENARIO'
  | 'PORTFOLIO';

export function projectForDimension(
  name: DimensionName,
  snapshot: StockSnapshot,
): DimensionFactView {
  switch (name) {
    case 'FUNDAMENTAL':
      return projectForFundamental(snapshot);
    case 'VALUATION':
      return projectForValuation(snapshot);
    case 'TECHNICAL':
      return projectForTechnical(snapshot);
    case 'RISK':
      return projectForRisk(snapshot);
    case 'SENTIMENT':
      return projectForSentiment(snapshot);
    case 'GOVERNANCE':
      return projectForGovernance(snapshot);
    case 'INDUSTRY':
      return projectForIndustry(snapshot);
    case 'SCENARIO':
      return projectForScenario(snapshot);
    case 'PORTFOLIO':
      return projectForPortfolio(snapshot);
    default: {
      const _exhaustive: never = name;
      void _exhaustive;
      throw new Error(`projectForDimension: unknown dimension ${String(name)}`);
    }
  }
}
