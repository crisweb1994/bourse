import { describe, expect, it } from 'vitest';
import {
  computeHistoricalContext,
  computePeerComparison,
  listExpectedPeers,
  type PeerMetrics,
} from '../relative';
import { findPeerGroup, findSectorForSymbol } from '../peer-table';

// ============================================================================
// Peer table
// ============================================================================

describe('peer-table', () => {
  it('looks up a peer group by sector', () => {
    const peers = findPeerGroup('US', 'technology');
    expect(peers.length).toBeGreaterThan(0);
    expect(peers.some((p) => p.symbol === 'AAPL')).toBe(true);
  });

  it('is case- and separator-insensitive for sector keys', () => {
    expect(findPeerGroup('US', 'Technology').length).toBeGreaterThan(0);
    expect(findPeerGroup('US', 'TECHNOLOGY').length).toBeGreaterThan(0);
    expect(findPeerGroup('US', 'consumer-staples').length).toBeGreaterThan(0);
    expect(findPeerGroup('US', 'consumer staples').length).toBeGreaterThan(0);
  });

  it('returns empty when sector is unknown', () => {
    expect(findPeerGroup('US', 'mythical-beasts')).toEqual([]);
    expect(findPeerGroup('US', null)).toEqual([]);
  });

  it('reverse-looks-up sector by symbol', () => {
    expect(findSectorForSymbol('CN', '600519')).toBe('baijiu');
    expect(findSectorForSymbol('US', 'AAPL')).toBe('technology');
    expect(findSectorForSymbol('HK', '0700')).toBe('internet');
    expect(findSectorForSymbol('US', 'ZZZZZ')).toBeNull();
  });
});

// ============================================================================
// computePeerComparison
// ============================================================================

const baijiuMetrics: Record<string, PeerMetrics> = {
  '000858': { pe: 18, pb: 4, roe: 0.25, netMargin: 0.35, revenueGrowthYoY: 0.1 },
  '000568': { pe: 20, pb: 5, roe: 0.27, netMargin: 0.4, revenueGrowthYoY: 0.12 },
  '600809': { pe: 22, pb: 6, roe: 0.3, netMargin: 0.32, revenueGrowthYoY: 0.18 },
  '000799': { pe: 15, pb: 3, roe: 0.18, netMargin: 0.25, revenueGrowthYoY: 0.05 },
};

describe('computePeerComparison · happy path', () => {
  it('builds peer set with metrics and computes subject rank', () => {
    const out = computePeerComparison({
      subjectSymbol: '600519',
      subjectMarket: 'CN',
      subjectSector: 'baijiu',
      subjectMetrics: {
        pe: 25,
        pb: 7,
        roe: 0.32,
        netMargin: 0.5,
        revenueGrowthYoY: 0.15,
      },
      peerMetrics: new Map(Object.entries(baijiuMetrics)),
    });
    expect(out!.sector).toBe('baijiu');
    expect(out!.peers).toHaveLength(4);
    // Subject PE 25 above all peers (18, 20, 22, 15) → rank 100
    expect(out!.subjectVsPeerMedian.pe.rankPercentile).toBe(100);
    // Peer PE sorted = [15, 18, 20, 22] → median = (18+20)/2 = 19
    expect(out!.subjectVsPeerMedian.pe.median).toBeCloseTo(19, 4);
    // ROE subject 32%, peers (18, 25, 27, 30) — 4 below → rank 100
    expect(out!.subjectVsPeerMedian.roe.rankPercentile).toBe(100);
  });

  it('infers sector from symbol when not provided', () => {
    const out = computePeerComparison({
      subjectSymbol: '600519',
      subjectMarket: 'CN',
      subjectSector: null,
      subjectMetrics: {
        pe: 25,
        pb: 7,
        roe: 0.32,
        netMargin: 0.5,
        revenueGrowthYoY: 0.15,
      },
      peerMetrics: new Map(Object.entries(baijiuMetrics)),
    });
    expect(out).not.toBeNull();
    expect(out!.sector).toBe('baijiu');
  });

  it('drops the subject from the peer set even when it sits in the table', () => {
    const out = computePeerComparison({
      subjectSymbol: '600519',
      subjectMarket: 'CN',
      subjectSector: 'baijiu',
      subjectMetrics: {
        pe: 25, pb: 7, roe: 0.32, netMargin: 0.5, revenueGrowthYoY: 0.15,
      },
      peerMetrics: new Map([
        ['600519', { pe: 25, pb: 7, roe: 0.32, netMargin: 0.5, revenueGrowthYoY: 0.15 }],
        ...Object.entries(baijiuMetrics),
      ]),
    });
    expect(out!.peers.some((p) => p.symbol === '600519')).toBe(false);
  });

  it('silently drops peers whose metrics were not fetched', () => {
    const partial = new Map(Object.entries(baijiuMetrics).slice(0, 2));
    const out = computePeerComparison({
      subjectSymbol: '600519',
      subjectMarket: 'CN',
      subjectSector: 'baijiu',
      subjectMetrics: {
        pe: 25, pb: 7, roe: 0.32, netMargin: 0.5, revenueGrowthYoY: 0.15,
      },
      peerMetrics: partial,
    });
    expect(out!.peers).toHaveLength(2);
    expect(out!.subjectVsPeerMedian.pe.peerCount).toBe(2);
  });

  it('returns null when sector cannot be resolved', () => {
    const out = computePeerComparison({
      subjectSymbol: 'XYZ',
      subjectMarket: 'US',
      subjectSector: null,
      subjectMetrics: {
        pe: 20, pb: 3, roe: 0.15, netMargin: 0.1, revenueGrowthYoY: 0.05,
      },
      peerMetrics: new Map(),
    });
    expect(out).toBeNull();
  });

  it('handles peer metric nulls in median + rank gracefully', () => {
    const out = computePeerComparison({
      subjectSymbol: '600519',
      subjectMarket: 'CN',
      subjectSector: 'baijiu',
      subjectMetrics: { pe: 25, pb: null, roe: 0.3, netMargin: 0.4, revenueGrowthYoY: 0.1 },
      peerMetrics: new Map([
        ['000858', { pe: 18, pb: null, roe: 0.25, netMargin: 0.35, revenueGrowthYoY: 0.1 }],
        ['000568', { pe: 20, pb: null, roe: 0.27, netMargin: 0.4, revenueGrowthYoY: 0.12 }],
      ]),
    });
    // PB all null → peerCount=0, median=null
    expect(out!.subjectVsPeerMedian.pb.peerCount).toBe(0);
    expect(out!.subjectVsPeerMedian.pb.median).toBeNull();
    expect(out!.subjectVsPeerMedian.pb.rankPercentile).toBeNull();
    // PE still works
    expect(out!.subjectVsPeerMedian.pe.median).toBeCloseTo(19, 4);
  });
});

describe('listExpectedPeers', () => {
  it('returns peers excluding subject', () => {
    const peers = listExpectedPeers('CN', 'baijiu', '600519');
    expect(peers.length).toBeGreaterThan(0);
    expect(peers.some((p) => p.symbol === '600519')).toBe(false);
  });
});

// ============================================================================
// computeHistoricalContext
// ============================================================================

describe('computeHistoricalContext', () => {
  it('returns null percentile/zScore when history is empty', () => {
    const out = computeHistoricalContext({
      metric: 'pe',
      current: 25,
      history: [],
    });
    expect(out.percentile5y).toBeNull();
    expect(out.zScore5y).toBeNull();
  });

  it('returns null percentile/zScore when current is null', () => {
    const out = computeHistoricalContext({
      metric: 'pe',
      current: null,
      history: [
        { period: 'Q1', value: 20 },
        { period: 'Q2', value: 22 },
      ],
    });
    expect(out.percentile5y).toBeNull();
    expect(out.zScore5y).toBeNull();
  });

  it('current above all history → 100th percentile, positive z-score', () => {
    const out = computeHistoricalContext({
      metric: 'pe',
      current: 30,
      history: [
        { period: 'Q1', value: 18 },
        { period: 'Q2', value: 20 },
        { period: 'Q3', value: 22 },
      ],
    });
    expect(out.percentile5y).toBe(100);
    expect(out.zScore5y!).toBeGreaterThan(0);
  });

  it('current at median → ~50th percentile, ~0 z-score', () => {
    const out = computeHistoricalContext({
      metric: 'pe',
      current: 20,
      history: [
        { period: 'Q1', value: 18 },
        { period: 'Q2', value: 20 },
        { period: 'Q3', value: 22 },
      ],
    });
    // 1 of 3 below 20 → 33%
    expect(out.percentile5y).toBeCloseTo(33.333, 1);
    expect(Math.abs(out.zScore5y!)).toBeLessThan(0.1);
  });

  it('drops invalid values (NaN, ≤0) from cleaned history', () => {
    const out = computeHistoricalContext({
      metric: 'pe',
      current: 25,
      history: [
        { period: 'Q1', value: 20 },
        { period: 'Q2', value: NaN },
        { period: 'Q3', value: -5 },
        { period: 'Q4', value: 30 },
      ],
    });
    expect(out.history).toHaveLength(2);
  });

  it('zero stddev (constant history) returns null z-score, valid percentile', () => {
    const out = computeHistoricalContext({
      metric: 'pe',
      current: 25,
      history: [
        { period: 'Q1', value: 20 },
        { period: 'Q2', value: 20 },
      ],
    });
    expect(out.zScore5y).toBeNull();
    expect(out.percentile5y).toBe(100); // 2 < 25
  });
});
