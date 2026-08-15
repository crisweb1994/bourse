import { describe, expect, it } from 'vitest';
import {
  projectForCompanyQuality,
  projectForDimension,
  projectForIndustryPosition,
  projectForMarketSignals,
  projectForRiskRegister,
  projectForValuationScenarios,
} from '../fact-filter';
import type { StockSnapshot } from '../types';

const snapshot = {
  rawFacts: {
    quote: { value: 1 }, history: [{ close: 1 }], profile: { sector: 'Tech' },
    financials: { periods: [] }, filings: [], consensusEps: { rows: [] },
    northboundFlow: [], lhb: [], unlockCalendar: [], shareholders: [],
    webSearch: {}, macro: null,
  },
  computedFacts: {
    financialRatios: { pe: 1 }, technicalIndicators: { bars: 20 }, redFlags: [],
    valuation: { methods: [] }, peerComparison: { peers: [] }, historicalContext: [],
  },
} as unknown as StockSnapshot;

describe('snapshot fact projections V2', () => {
  it('keeps each module view narrow and explicit', () => {
    expect(Object.keys(projectForCompanyQuality(snapshot).rawFacts).sort())
      .toEqual(['financials', 'profile', 'quote']);
    expect(Object.keys(projectForIndustryPosition(snapshot).rawFacts).sort())
      .toEqual(['filings', 'profile']);
    expect(Object.keys(projectForValuationScenarios(snapshot).computedFacts).sort())
      .toEqual(['financialRatios', 'historicalContext', 'peerComparison', 'valuation']);
    expect(Object.keys(projectForRiskRegister(snapshot).rawFacts).sort())
      .toEqual(['filings', 'financials', 'quote']);
    expect(Object.keys(projectForMarketSignals(snapshot).rawFacts).sort())
      .toEqual(['history', 'quote']);
  });

  it('dispatches by the five public section names and rejects old names', () => {
    expect(projectForDimension('MARKET_SIGNALS', snapshot).needsWebSearch).toBe(false);
    expect(projectForDimension('INDUSTRY_POSITION', snapshot).needsWebSearch).toBe(true);
    expect(() => projectForDimension('TECHNICAL' as never, snapshot)).toThrow();
  });
});
