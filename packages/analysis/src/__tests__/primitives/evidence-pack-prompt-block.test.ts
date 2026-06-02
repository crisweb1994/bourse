import { describe, expect, it } from 'vitest';
import type { EvidencePackV2 } from '../../contracts/evidence-pack-v2';
import { formatEvidencePackBlock } from '../../primitives/dimension-prompts';

const ISO = '2026-05-14T08:00:00.000Z';

function fact<T>(value: T, sourceUrl: string, tier: 'A' | 'B' | 'C' | 'D' | 'E') {
  return {
    value,
    asOf: ISO,
    retrievedAt: ISO,
    sourceUrl,
    sourceTier: tier,
  };
}

function basePack(facts: Partial<EvidencePackV2['facts']>): EvidencePackV2 {
  return {
    schemaVersion: 'evidence-pack-v2',
    symbol: '600519.SS',
    market: 'CN',
    capturedAt: ISO,
    facts,
    dataAvailability: { complete: [], missing: [], fallbacks: [] },
    citations: [],
    trace: { toolCalls: 0, durationMs: 0, costUsd: 0 },
  };
}

describe('primitives/formatEvidencePackBlock — structure', () => {
  it('includes header + capture metadata + citation rules sections', () => {
    const out = formatEvidencePackBlock(basePack({}));
    expect(out).toContain('【事实包 (EvidencePack v2)】');
    expect(out).toContain('600519.SS');
    expect(out).toContain('CN');
    expect(out).toContain(ISO);
    expect(out).toContain('【引用规则】');
    expect(out).toContain('factReferences');
  });

  it('omits missing-facts section when no missing fields', () => {
    const out = formatEvidencePackBlock(basePack({}));
    expect(out).not.toContain('【数据缺失】');
  });

  it('includes missing-facts section when there are missing fields', () => {
    const pack = basePack({});
    pack.dataAvailability.missing = [
      { field: 'lhbAppearances', reason: 'rate_limited_after_retries' },
      { field: 'unlockCalendar', reason: 'eastmoney returned empty payload' },
    ];
    const out = formatEvidencePackBlock(pack);
    // Genuinely-failed fetches (rate_limited / empty payload) → searchable group.
    expect(out).toContain('【数据缺失·可补充】');
    expect(out).toContain('lhbAppearances');
    expect(out).toContain('rate_limited_after_retries');
    expect(out).toContain('unlockCalendar');
  });
});

describe('primitives/formatEvidencePackBlock — fact formatting', () => {
  it('formats scalar number facts with unit + provenance', () => {
    const out = formatEvidencePackBlock(
      basePack({
        quote: fact(1820.5, 'https://qt.gtimg.cn/q=sh600519', 'B'),
      }),
    );
    expect(out).toMatch(/- quote: 1820\.5/);
    expect(out).toContain('tier=B');
    expect(out).toContain('source=qt.gtimg.cn');
  });

  it('strips www. prefix from source hostnames', () => {
    const out = formatEvidencePackBlock(
      basePack({
        latestFilingUrls: fact(
          ['https://www.cninfo.com.cn/x.pdf'],
          'https://www.cninfo.com.cn/new/hisAnnouncement/query',
          'A',
        ),
      }),
    );
    expect(out).toContain('source=cninfo.com.cn');
    expect(out).not.toContain('source=www.cninfo.com.cn');
  });

  it('embeds unit annotation when present', () => {
    const factWithUnit = {
      ...fact(22875.6, 'https://qt.gtimg.cn/q=sh600519', 'B'),
      unit: '亿元',
    };
    const out = formatEvidencePackBlock(
      basePack({ marketCap: factWithUnit }),
    );
    expect(out).toContain('22875.6 亿元');
  });

  it('inlines short arrays as JSON', () => {
    const out = formatEvidencePackBlock(
      basePack({
        consensusEps: fact(
          [
            { year: 2026, value: 70.5 },
            { year: 2027, value: 78.2 },
          ],
          'https://datacenter.eastmoney.com/x',
          'B',
        ),
      }),
    );
    expect(out).toContain('"year":2026');
    expect(out).toContain('"value":78.2');
  });

  it('truncates long JSON values at 500 chars (with ellipsis)', () => {
    const longArr = Array.from({ length: 100 }, (_, i) => ({
      year: 2000 + i,
      value: i * 1.0,
    }));
    const out = formatEvidencePackBlock(
      basePack({
        consensusEps: fact(
          longArr as unknown as Array<{ year: number; value: number }>,
          'https://datacenter.eastmoney.com/x',
          'B',
        ),
      }),
    );
    const consensusLine = out
      .split('\n')
      .find((l) => l.startsWith('- consensusEps:'))!;
    expect(consensusLine.length).toBeLessThan(700);
    expect(consensusLine).toContain('...');
  });

  it('skips fact entries that are undefined', () => {
    const out = formatEvidencePackBlock(
      basePack({
        quote: fact(100, 'https://qt.gtimg.cn/x', 'B'),
        // marketCap intentionally omitted
      }),
    );
    expect(out).toContain('- quote:');
    expect(out).not.toContain('- marketCap:');
  });

  it('preserves stable fact ordering even if facts arrive in different order', () => {
    const out = formatEvidencePackBlock(
      basePack({
        pe: fact(28.7, 'https://qt.gtimg.cn/x', 'B'),
        quote: fact(1820.5, 'https://qt.gtimg.cn/x', 'B'),
        latestFilingUrls: fact(
          ['https://static.cninfo.com.cn/x.pdf'],
          'https://www.cninfo.com.cn/x',
          'A',
        ),
      }),
    );
    const quoteIdx = out.indexOf('- quote:');
    const peIdx = out.indexOf('- pe:');
    const filingIdx = out.indexOf('- latestFilingUrls:');
    expect(quoteIdx).toBeLessThan(peIdx);
    expect(peIdx).toBeLessThan(filingIdx);
  });
});

describe('primitives/formatEvidencePackBlock — financials block (RFC Phase 1)', () => {
  const bundleFact = (periods: Array<Record<string, unknown>>) => ({
    value: {
      periods,
      currency: 'USD',
      sourceUrl: 'https://data.sec.gov/api/xbrl/companyfacts/CIK0000320193.json',
      retrievedAt: ISO,
    },
    asOf: '2024-09-28',
    retrievedAt: ISO,
    sourceUrl: 'https://data.sec.gov/api/xbrl/companyfacts/CIK0000320193.json',
    sourceTier: 'A' as const,
  });

  it('emits header line with period count, currency, and SEC source host', () => {
    const out = formatEvidencePackBlock(
      basePack({
        financials: bundleFact([
          {
            fiscalPeriod: 'FY2024',
            kind: 'FY',
            income: { revenue: { value: 391_000_000_000, unit: 'USD' } },
            cashFlow: {},
          },
        ]) as never,
      }),
    );
    expect(out).toContain('- financials: 三表 (USD, 1 periods)');
    expect(out).toContain('tier=A');
    expect(out).toContain('source=data.sec.gov');
  });

  it('renders revenue / netIncome / OCF / FCF / EPS with B/M/K scaling', () => {
    const out = formatEvidencePackBlock(
      basePack({
        financials: bundleFact([
          {
            fiscalPeriod: 'FY2024',
            kind: 'FY',
            income: {
              revenue: { value: 391_035_000_000, unit: 'USD' },
              netIncome: { value: 93_736_000_000, unit: 'USD' },
              eps: { value: 6.11, unit: 'USD/shares' },
            },
            cashFlow: {
              operatingCashFlow: { value: 118_254_000_000, unit: 'USD' },
              freeCashFlow: { value: 108_807_000_000, unit: 'USD' },
            },
          },
        ]) as never,
      }),
    );
    expect(out).toContain('FY2024:');
    expect(out).toContain('revenue=391.04B');
    expect(out).toContain('netIncome=93.74B');
    expect(out).toContain('OCF=118.25B');
    expect(out).toContain('FCF=108.81B');
    expect(out).toContain('EPS=6.11 USD/shares');
  });

  it('caps period rendering at 6 entries (drops the tail of long histories)', () => {
    const periods = Array.from({ length: 9 }, (_, i) => ({
      fiscalPeriod: `FY${2020 + i}`,
      kind: 'FY' as const,
      income: { revenue: { value: 1_000_000 + i, unit: 'USD' } },
      cashFlow: {},
    }));
    const out = formatEvidencePackBlock(
      basePack({ financials: bundleFact(periods) as never }),
    );
    // First 6 included.
    expect(out).toContain('FY2020:');
    expect(out).toContain('FY2025:');
    // Tail dropped.
    expect(out).not.toContain('FY2026:');
    expect(out).not.toContain('FY2028:');
  });

  it('skips missing line items rather than emitting empty parts', () => {
    const out = formatEvidencePackBlock(
      basePack({
        financials: bundleFact([
          {
            fiscalPeriod: 'Q3-FY2024',
            kind: 'Q',
            income: { revenue: { value: 94_930_000_000, unit: 'USD' } },
            cashFlow: {},
          },
        ]) as never,
      }),
    );
    const line = out.split('\n').find((l) => l.includes('Q3-FY2024:'))!;
    expect(line).toContain('revenue=94.93B');
    expect(line).not.toContain('netIncome=');
    expect(line).not.toContain('OCF=');
    expect(line).not.toContain('FCF=');
    expect(line).not.toContain('EPS=');
  });

  it('orders financials after the standard fact rows', () => {
    const out = formatEvidencePackBlock(
      basePack({
        financials: bundleFact([
          {
            fiscalPeriod: 'FY2024',
            kind: 'FY',
            income: { revenue: { value: 1_000_000, unit: 'USD' } },
            cashFlow: {},
          },
        ]) as never,
        quote: fact(228.5, 'https://finance.yahoo.com/quote/AAPL', 'B'),
      }),
    );
    const quoteIdx = out.indexOf('- quote:');
    const finIdx = out.indexOf('- financials:');
    expect(quoteIdx).toBeLessThan(finIdx);
  });
});

describe('primitives/formatEvidencePackBlock — robustness', () => {
  it('emits "unknown" host for malformed sourceUrl', () => {
    const badFact = {
      ...fact(1, 'not-a-url', 'D'),
    };
    // Note: zod would normally reject this at the pack-construction stage, but
    // the helper should still degrade gracefully if a bad URL slipped through.
    const out = formatEvidencePackBlock(basePack({ quote: badFact as any }));
    expect(out).toContain('source=unknown');
  });
});

describe('primitives/formatEvidencePackBlock — gap-fill (always on)', () => {
  function packWithMissing(): EvidencePackV2 {
    const p = basePack({});
    p.dataAvailability.missing = [
      { field: 'consensusEps', reason: 'no analyst coverage' },
    ];
    return p;
  }

  it('permits marked web_search for missing fields only', () => {
    const out = formatEvidencePackBlock(packWithMissing());
    expect(out).toContain('可以用 web_search 自主补充');
    expect(out).toContain('(网搜补充·未经代码核验)');
    expect(out).not.toContain('不允许 web_search 重取');
  });

  it('web-sourced values may not override code-verified facts (invariant #1 intact)', () => {
    const out = formatEvidencePackBlock(packWithMissing());
    expect(out).toContain('不得用于覆盖上方已有的代码核验值');
  });

  it('not_configured fields are excluded from the web_search invitation', () => {
    const p = basePack({});
    p.dataAvailability.missing = [
      { field: 'unlockCalendar', reason: 'connector_error: eastmoney 500' },
      { field: 'consensusEps', reason: 'not_configured' },
    ];
    const out = formatEvidencePackBlock(p);
    expect(out).toContain('数据缺失·可补充');
    expect(out).toContain('数据缺失·本市场不适用');
    // failed fetch → searchable section; not_configured → unavailable section
    const [searchablePart, unavailablePart] = out.split('本市场不适用');
    expect(searchablePart).toContain('unlockCalendar');
    expect(searchablePart).not.toContain('consensusEps');
    expect(unavailablePart).toContain('consensusEps');
  });
});
