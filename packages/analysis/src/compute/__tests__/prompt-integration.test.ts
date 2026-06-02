import { describe, expect, it } from 'vitest';
import type { EvidencePackV2 } from '../../contracts/evidence-pack-v2';
import { formatEvidencePackBlock } from '../../primitives/dimension-prompts';

function emptyPack(overrides: Partial<EvidencePackV2> = {}): EvidencePackV2 {
  return {
    schemaVersion: 'evidence-pack-v2',
    symbol: 'AAPL',
    market: 'US',
    capturedAt: '2025-05-25T15:00:00.000Z',
    facts: {},
    dataAvailability: { complete: [], missing: [], fallbacks: [] },
    citations: [],
    trace: {
      durationMs: 0,
      toolCalls: 0,
      costUsd: 0,
      snapshotId: 'snap-test',
      originCounts: { fromSnapshot: 0, providerNative: 0 },
      augmentedFactKeys: [],
      snapshotFactMapping: [],
    },
    ...overrides,
  };
}

describe('dimension-prompts · computedFacts rendering', () => {
  it('omits the computed block when EvidencePack has no computedFacts', () => {
    const out = formatEvidencePackBlock(emptyPack());
    expect(out).not.toContain('【已计算指标】');
    // The "禁止重算" advice must NOT leak when the block is absent
    expect(out).not.toContain('禁止重新推导');
  });

  it('renders the block header and instruction when computedFacts present', () => {
    const out = formatEvidencePackBlock(
      emptyPack({
        computedFacts: {
          ratios: null,
          technical: null,
          valuation: null,
          peerComparison: null,
          historicalContext: [],
          redFlags: [],
          warnings: [],
        },
      }),
    );
    expect(out).toContain('【已计算指标】');
    expect(out).toContain('必须直接引用');
    // Citation rules note the compute block too
    expect(out).toContain('比率 / 技术指标 / 红旗已由 TS 代码确定性计算');
  });

  it('renders ratio numbers with proper formatting', () => {
    const out = formatEvidencePackBlock(
      emptyPack({
        computedFacts: {
          ratios: {
            pe: 28.5,
            pb: 5.98,
            ps: 8.2,
            fcfYield: 0.031,
            evToEbitda: 19.3,
            grossMargin: 0.915,
            operatingMargin: 0.25,
            netMargin: 0.496,
            roe: 0.223,
            roic: 0.151,
            cashConversionRatio: 0.985,
            accrualRatio: 0.02,
            debtToEquity: 1.5,
            currentRatio: null,
            quickRatio: null,
            interestCoverage: null,
            revenueGrowthYoY: 0.152,
            earningsGrowthYoY: 0.138,
            revenueCagr3y: 0.124,
            fcfCagr3y: null,
            periodTrends: [
              {
                period: 'TTM-as-of-Q1-FY2025',
                fiscalYearEnd: '2025-03-31',
                revenue: 100_000_000_000,
                netIncome: 20_000_000_000,
                grossMargin: 0.45,
                netMargin: 0.2,
                operatingCashFlow: 22_000_000_000,
              },
            ],
            baseCurrency: 'USD',
            computedAt: '2025-05-25T15:00:00.000Z',
          },
          technical: null,
          valuation: null,
          peerComparison: null,
          historicalContext: [],
          redFlags: [],
          warnings: [],
        },
      }),
    );
    expect(out).toContain('PE=28.50');
    expect(out).toContain('PB=5.98');
    expect(out).toContain('毛利率=91.50%');
    expect(out).toContain('ROE=22.30%');
    expect(out).toContain('营收YoY=15.20%');
    expect(out).toContain('基础货币: USD');
    expect(out).toContain('TTM-as-of-Q1-FY2025');
    expect(out).toContain('营收=100.00B');
  });

  it('renders technical indicators with trend labels', () => {
    const out = formatEvidencePackBlock(
      emptyPack({
        computedFacts: {
          ratios: null,
          technical: {
            asOf: '2025-05-25T00:00:00.000Z',
            bars: 250,
            lastClose: 182.5,
            sma20: 180,
            sma50: 175,
            sma200: 165,
            currentVsSma200: 'above',
            rsi14: 62.5,
            macdLine: 1.2,
            macdSignal: 0.8,
            macdHistogram: 0.4,
            macdTrend: 'bullish',
            atr14: 3.2,
            bollingerUpper: 188,
            bollingerMiddle: 180,
            bollingerLower: 172,
            bollingerPosition: 'upper_half',
            nearestSupport: 178,
            nearestResistance: 187,
            volumeVs20dAvg: 1.15,
            obvTrend: 'rising',
            trend: 'uptrend',
            momentum: 'neutral',
          },
          valuation: null,
          peerComparison: null,
          historicalContext: [],
          redFlags: [],
          warnings: [],
        },
      }),
    );
    expect(out).toContain('技术指标 (250 个交易日');
    expect(out).toContain('收盘=182.50');
    expect(out).toContain('SMA200=165.00');
    expect(out).toContain('vs SMA200=above');
    expect(out).toContain('RSI14=62.5');
    expect(out).toContain('MACD趋势=bullish');
    expect(out).toContain('趋势=uptrend');
  });

  it('renders red flags with severity prefix', () => {
    const out = formatEvidencePackBlock(
      emptyPack({
        computedFacts: {
          ratios: null,
          technical: null,
          valuation: null,
          peerComparison: null,
          historicalContext: [],
          redFlags: [
            {
              rule: 'fcf_ni_divergence',
              severity: 'high',
              category: 'cash_flow',
              title: '净利为正但 FCF 连续 2 期为负',
              description: '具体数据 ...',
              evidence: { latestNetIncome: 100, latestFreeCashFlow: -50 },
            },
          ],
          warnings: [],
        },
      }),
    );
    expect(out).toContain('红旗 (1 条');
    expect(out).toContain('[HIGH/cash_flow]');
    expect(out).toContain('净利为正但 FCF 连续 2 期为负');
  });

  it('renders compute warnings when present', () => {
    const out = formatEvidencePackBlock(
      emptyPack({
        computedFacts: {
          ratios: null,
          technical: null,
          valuation: null,
          peerComparison: null,
          historicalContext: [],
          redFlags: [],
          warnings: [
            {
              code: 'unknown_unit',
              metric: 'revenue',
              detail: "Unrecognized unit 'parsec'",
            },
          ],
        },
      }),
    );
    expect(out).toContain('计算告警 (1 条');
    expect(out).toContain('[unknown_unit] revenue');
  });

  it('does not render fields that are null (clean output)', () => {
    const out = formatEvidencePackBlock(
      emptyPack({
        computedFacts: {
          ratios: {
            pe: 28.5,
            pb: null,
            ps: null,
            fcfYield: null,
            evToEbitda: null,
            grossMargin: null,
            operatingMargin: null,
            netMargin: null,
            roe: null,
            roic: null,
            cashConversionRatio: null,
            accrualRatio: null,
            debtToEquity: null,
            currentRatio: null,
            quickRatio: null,
            interestCoverage: null,
            revenueGrowthYoY: null,
            earningsGrowthYoY: null,
            revenueCagr3y: null,
            fcfCagr3y: null,
            periodTrends: [],
            baseCurrency: 'USD',
            computedAt: '2025-05-25T15:00:00.000Z',
          },
          technical: null,
          valuation: null,
          peerComparison: null,
          historicalContext: [],
          redFlags: [],
          warnings: [],
        },
      }),
    );
    expect(out).toContain('PE=28.50');
    // Not broadcasting "PB=null" or similar noise
    expect(out).not.toContain('null');
    expect(out).not.toContain('NaN');
  });
});
