/**
 * sec-edgar-xbrl connector 单测。
 *
 * 用 fixture XBRL 测试解析 + TTM + provenance。不打真 HTTP。
 * 真 HTTP 集成测：见同目录 sec-edgar-xbrl.live.test.ts（手动 / CI live mode）。
 */
import { describe, expect, it } from 'vitest';
import type { FetchLike } from '../types';
import type { CikLookup } from '../filings/cik-lookup';
import { createSecEdgarXbrlFinancialsConnector } from './sec-edgar-xbrl';

// ============================================================================
// Fixture helpers
// ============================================================================

type Fp = 'FY' | 'Q1' | 'Q2' | 'Q3' | 'Q4';

function fact(opts: {
  fy: number;
  fp: Fp;
  val: number;
  end: string;
  filed: string;
  form?: string;
}) {
  return {
    end: opts.end,
    val: opts.val,
    fy: opts.fy,
    fp: opts.fp,
    form: opts.form ?? (opts.fp === 'FY' ? '10-K' : '10-Q'),
    filed: opts.filed,
  };
}

/**
 * 构造 minimal SEC companyfacts JSON：FY2023 + FY2024 + 4 个 FY2024 Q。
 * 仅填关键 concept，足够覆盖快乐路径 + TTM 派生。
 */
function buildAaplFixture() {
  return {
    cik: 320193,
    entityName: 'Apple Inc.',
    facts: {
      'us-gaap': {
        Revenues: {
          units: {
            USD: [
              fact({ fy: 2023, fp: 'FY', val: 383_285_000_000, end: '2023-09-30', filed: '2023-11-03' }),
              fact({ fy: 2024, fp: 'Q1', val: 119_575_000_000, end: '2023-12-30', filed: '2024-02-02' }),
              fact({ fy: 2024, fp: 'Q2', val: 90_753_000_000, end: '2024-03-30', filed: '2024-05-03' }),
              fact({ fy: 2024, fp: 'Q2', val: 81_797_000_000, end: '2023-04-01', filed: '2024-05-03' }),
              fact({ fy: 2024, fp: 'Q3', val: 85_777_000_000, end: '2024-06-29', filed: '2024-08-02' }),
              fact({ fy: 2024, fp: 'FY', val: 391_035_000_000, end: '2024-09-28', filed: '2024-11-01' }),
            ],
          },
        },
        CostOfRevenue: {
          units: {
            USD: [
              fact({ fy: 2023, fp: 'FY', val: 214_137_000_000, end: '2023-09-30', filed: '2023-11-03' }),
              fact({ fy: 2024, fp: 'Q1', val: 64_720_000_000, end: '2023-12-30', filed: '2024-02-02' }),
              fact({ fy: 2024, fp: 'Q2', val: 48_482_000_000, end: '2024-03-30', filed: '2024-05-03' }),
              fact({ fy: 2024, fp: 'Q3', val: 46_099_000_000, end: '2024-06-29', filed: '2024-08-02' }),
              fact({ fy: 2024, fp: 'FY', val: 210_352_000_000, end: '2024-09-28', filed: '2024-11-01' }),
            ],
          },
        },
        NetIncomeLoss: {
          units: {
            USD: [
              fact({ fy: 2023, fp: 'FY', val: 96_995_000_000, end: '2023-09-30', filed: '2023-11-03' }),
              fact({ fy: 2024, fp: 'Q1', val: 33_916_000_000, end: '2023-12-30', filed: '2024-02-02' }),
              fact({ fy: 2024, fp: 'Q2', val: 23_636_000_000, end: '2024-03-30', filed: '2024-05-03' }),
              fact({ fy: 2024, fp: 'Q3', val: 21_448_000_000, end: '2024-06-29', filed: '2024-08-02' }),
              fact({ fy: 2024, fp: 'FY', val: 93_736_000_000, end: '2024-09-28', filed: '2024-11-01' }),
            ],
          },
        },
        EarningsPerShareDiluted: {
          units: {
            'USD/shares': [
              fact({ fy: 2023, fp: 'FY', val: 6.13, end: '2023-09-30', filed: '2023-11-03' }),
              fact({ fy: 2024, fp: 'FY', val: 6.08, end: '2024-09-28', filed: '2024-11-01' }),
            ],
          },
        },
        Assets: {
          units: {
            USD: [
              fact({ fy: 2023, fp: 'FY', val: 352_583_000_000, end: '2023-09-30', filed: '2023-11-03' }),
              fact({ fy: 2024, fp: 'Q3', val: 331_612_000_000, end: '2024-06-29', filed: '2024-08-02' }),
              fact({ fy: 2024, fp: 'FY', val: 364_980_000_000, end: '2024-09-28', filed: '2024-11-01' }),
            ],
          },
        },
        Liabilities: {
          units: {
            USD: [
              fact({ fy: 2024, fp: 'FY', val: 308_030_000_000, end: '2024-09-28', filed: '2024-11-01' }),
            ],
          },
        },
        StockholdersEquity: {
          units: {
            USD: [
              fact({ fy: 2024, fp: 'FY', val: 56_950_000_000, end: '2024-09-28', filed: '2024-11-01' }),
            ],
          },
        },
        CashAndCashEquivalentsAtCarryingValue: {
          units: {
            USD: [
              fact({ fy: 2024, fp: 'FY', val: 29_943_000_000, end: '2024-09-28', filed: '2024-11-01' }),
            ],
          },
        },
        NetCashProvidedByUsedInOperatingActivities: {
          units: {
            USD: [
              fact({ fy: 2023, fp: 'FY', val: 110_543_000_000, end: '2023-09-30', filed: '2023-11-03' }),
              { ...fact({ fy: 2024, fp: 'Q1', val: 39_895_000_000, end: '2023-12-30', filed: '2024-02-02' }), start: '2023-10-01' },
              { ...fact({ fy: 2024, fp: 'Q2', val: 68_054_000_000, end: '2024-03-30', filed: '2024-05-03' }), start: '2023-10-01' },
              { ...fact({ fy: 2024, fp: 'Q3', val: 94_865_000_000, end: '2024-06-29', filed: '2024-08-02' }), start: '2023-10-01' },
              fact({ fy: 2024, fp: 'FY', val: 118_254_000_000, end: '2024-09-28', filed: '2024-11-01' }),
            ],
          },
        },
        PaymentsToAcquirePropertyPlantAndEquipment: {
          units: {
            USD: [
              { ...fact({ fy: 2024, fp: 'Q1', val: 2_392_000_000, end: '2023-12-30', filed: '2024-02-02' }), start: '2023-10-01' },
              { ...fact({ fy: 2024, fp: 'Q2', val: 4_538_000_000, end: '2024-03-30', filed: '2024-05-03' }), start: '2023-10-01' },
              { ...fact({ fy: 2024, fp: 'Q3', val: 6_690_000_000, end: '2024-06-29', filed: '2024-08-02' }), start: '2023-10-01' },
              fact({ fy: 2024, fp: 'FY', val: 9_447_000_000, end: '2024-09-28', filed: '2024-11-01' }),
            ],
          },
        },
      },
    },
  };
}

/**
 * Mock fetch — 路由 ticker JSON 与 companyfacts JSON。
 */
function makeFetch(opts: {
  cikJson?: unknown;
  companyfactsJson?: unknown;
  companyfactsStatus?: number;
}): FetchLike {
  return (async (url: string | URL, _init?: unknown) => {
    const u = typeof url === 'string' ? url : url.toString();
    if (u.includes('company_tickers.json')) {
      return {
        ok: true,
        status: 200,
        async json() {
          return opts.cikJson ?? {
            '0': { cik_str: 320193, ticker: 'AAPL', title: 'Apple Inc.' },
          };
        },
      } as Response;
    }
    if (u.includes('/api/xbrl/companyfacts/')) {
      const status = opts.companyfactsStatus ?? 200;
      return {
        ok: status >= 200 && status < 300,
        status,
        async json() {
          return opts.companyfactsJson;
        },
      } as Response;
    }
    throw new Error(`unexpected fetch URL: ${u}`);
  }) as FetchLike;
}

const fixedUserAgent = 'test test@example.com';
const NOW = new Date('2024-11-15T00:00:00.000Z');

// ============================================================================
// Happy path
// ============================================================================

describe('sec-edgar-xbrl — happy path', () => {
  it('parses AAPL fixture into FinancialsBundle with TTM', async () => {
    const fetchLike = makeFetch({ companyfactsJson: buildAaplFixture() });
    const connector = createSecEdgarXbrlFinancialsConnector({
      userAgent: fixedUserAgent,
      fetchLike,
      now: () => NOW,
    });

    const result = await connector.fetchFinancials({ instrumentId: 'US:AAPL' });

    expect(result.warnings).toEqual([]);
    const bundle = result.data!;
    expect(bundle).not.toBeNull();
    expect(bundle.currency).toBe('USD');
    expect(bundle.sourceUrl).toContain('CIK0000320193.json');
    expect(bundle.retrievedAt).toBe(NOW.toISOString());
    expect(bundle.ttmSkippedReason).toBeUndefined();

    // periods 应包含：1 TTM + 3 explicit Q + 2 FY = 6
    // (note: Q4-FY2024 is reverse-derived inside TTM, not added to bundle periods)
    const kinds = bundle.periods.map((p) => p.kind);
    expect(kinds.filter((k) => k === 'TTM').length).toBe(1);
    expect(kinds.filter((k) => k === 'FY').length).toBeGreaterThanOrEqual(1);
    expect(kinds.filter((k) => k === 'Q').length).toBeGreaterThanOrEqual(3);

    // TTM 第一个；fiscalPeriod 命名 TTM-as-of-...
    expect(bundle.periods[0].kind).toBe('TTM');
    expect(bundle.periods[0].fiscalPeriod).toMatch(/^TTM-as-of-/);

    // TTM income.revenue = Q4 reverse-derived + Q3 + Q2 + Q1
    // Q4 = FY2024 (391.035B) - (Q1 119.575 + Q2 90.753 + Q3 85.777) = 94.93B
    // TTM = 94.93 + 85.777 + 90.753 + 119.575 = 391.035B (= FY2024 ⇒ 验证一致)
    expect(bundle.periods[0].income.revenue?.value).toBeCloseTo(391_035_000_000, -3);
    expect(bundle.periods[0].cashFlow.operatingCashFlow?.value).toBeCloseTo(118_254_000_000, -3);

    // FreeCashFlow = OCF - CapEx
    const fcf = bundle.periods[0].cashFlow.freeCashFlow;
    expect(fcf?.value).toBeCloseTo(
      bundle.periods[0].cashFlow.operatingCashFlow!.value -
        bundle.periods[0].cashFlow.capitalExpenditures!.value,
      -3,
    );

    // FY2024 entry 存在且 revenue 正确
    const fy2024 = bundle.periods.find((p) => p.fiscalPeriod === 'FY2024');
    expect(fy2024?.income.revenue?.value).toBe(391_035_000_000);
    expect(fy2024?.income.eps?.value).toBe(6.08);
    expect(fy2024?.income.eps?.unit).toBe('USD/shares');

    const q2fy2024 = bundle.periods.find((p) => p.fiscalPeriod === 'Q2-FY2024');
    expect(q2fy2024?.fiscalYearEnd).toBe('2024-03-30');
    expect(q2fy2024?.income.revenue?.value).toBe(90_753_000_000);
    expect(q2fy2024?.cashFlow.operatingCashFlow?.value).toBe(28_159_000_000);
    expect(q2fy2024?.cashFlow.capitalExpenditures?.value).toBe(2_146_000_000);

    // Citations + provenance
    expect(result.citations).toHaveLength(1);
    expect(result.citations[0].qualityTier).toBe('A');
    expect(result.citations[0].sourceType).toBe('FILING');
  });
});

// ============================================================================
// Failure paths
// ============================================================================

describe('sec-edgar-xbrl — failure paths', () => {
  it('returns null + UNSUPPORTED_MARKET for non-US instrumentId', async () => {
    const connector = createSecEdgarXbrlFinancialsConnector({
      userAgent: fixedUserAgent,
      fetchLike: makeFetch({}),
      now: () => NOW,
    });
    const result = await connector.fetchFinancials({ instrumentId: 'CN:600519' });
    expect(result.data).toBeNull();
    expect(result.warnings[0]?.code).toBe('UNSUPPORTED_MARKET');
  });

  it('returns null + INVALID_INSTRUMENT for unknown ticker', async () => {
    const connector = createSecEdgarXbrlFinancialsConnector({
      userAgent: fixedUserAgent,
      fetchLike: makeFetch({ cikJson: {} }),
      now: () => NOW,
    });
    const result = await connector.fetchFinancials({ instrumentId: 'US:FAKE' });
    expect(result.data).toBeNull();
    expect(result.warnings[0]?.code).toBe('INVALID_INSTRUMENT');
  });

  it('returns null with no warning when SEC 404 (foreign private / pink sheet)', async () => {
    const connector = createSecEdgarXbrlFinancialsConnector({
      userAgent: fixedUserAgent,
      fetchLike: makeFetch({ companyfactsStatus: 404, companyfactsJson: {} }),
      now: () => NOW,
    });
    const result = await connector.fetchFinancials({ instrumentId: 'US:AAPL' });
    expect(result.data).toBeNull();
    expect(result.warnings).toEqual([]);  // 404 = "no XBRL filed"，不是错误
  });

  it('returns null + SOURCE_UNAVAILABLE on HTTP 500', async () => {
    const connector = createSecEdgarXbrlFinancialsConnector({
      userAgent: fixedUserAgent,
      fetchLike: makeFetch({ companyfactsStatus: 500 }),
      now: () => NOW,
    });
    const result = await connector.fetchFinancials({ instrumentId: 'US:AAPL' });
    expect(result.data).toBeNull();
    expect(result.warnings[0]?.code).toBe('SOURCE_UNAVAILABLE');
  });

  it('returns null + PARTIAL_DATA when companyfacts JSON has no us-gaap', async () => {
    const connector = createSecEdgarXbrlFinancialsConnector({
      userAgent: fixedUserAgent,
      fetchLike: makeFetch({ companyfactsJson: { cik: 320193, facts: {} } }),
      now: () => NOW,
    });
    const result = await connector.fetchFinancials({ instrumentId: 'US:AAPL' });
    expect(result.data).toBeNull();
    expect(result.warnings[0]?.code).toBe('PARTIAL_DATA');
  });

  it('throws if userAgent missing (SEC compliance)', () => {
    expect(() =>
      createSecEdgarXbrlFinancialsConnector({ userAgent: '' }),
    ).toThrow(/non-empty userAgent/);
  });
});

// ============================================================================
// Options
// ============================================================================

describe('sec-edgar-xbrl — options', () => {
  it('honors deriveTTM=false (no TTM in output)', async () => {
    const connector = createSecEdgarXbrlFinancialsConnector({
      userAgent: fixedUserAgent,
      fetchLike: makeFetch({ companyfactsJson: buildAaplFixture() }),
      now: () => NOW,
    });
    const result = await connector.fetchFinancials({
      instrumentId: 'US:AAPL',
      deriveTTM: false,
    });
    const bundle = result.data!;
    expect(bundle.periods.find((p) => p.kind === 'TTM')).toBeUndefined();
  });

  it('honors years parameter (truncates FY entries)', async () => {
    const connector = createSecEdgarXbrlFinancialsConnector({
      userAgent: fixedUserAgent,
      fetchLike: makeFetch({ companyfactsJson: buildAaplFixture() }),
      now: () => NOW,
    });
    const result = await connector.fetchFinancials({
      instrumentId: 'US:AAPL',
      years: 1, // 只要 1 个 FY
    });
    const bundle = result.data!;
    expect(bundle.periods.filter((p) => p.kind === 'FY').length).toBeLessThanOrEqual(1);
  });
});
