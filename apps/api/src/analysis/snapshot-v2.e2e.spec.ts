/**
 * plan-v2 Wave 2.5 — end-to-end test for SnapshotV2 path.
 *
 * Strategy: instantiate SnapshotV2Service with stub ports that mimic
 * realistic CN tool responses, run fetch() + fetchAsEvidencePack(), and
 * verify the full pipeline:
 *   1. Snapshot orchestrator fans out + collects
 *   2. Compute layer runs against assembled rawFacts
 *   3. Adapter projects to EvidencePackV2
 *   4. Resulting pack passes EvidencePackV2.parse() and carries the
 *      expected fact keys
 *
 * This is the closest we can get to a "real" end-to-end test without
 * actually hitting Eastmoney / SEC / Yahoo. Network-mocked, but the
 * orchestration + classification + compute + adapter chain is real.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type {
  FilingPort,
  FilingSummary,
  FinancePort,
  FinancialsBundle,
  FinancialsPort,
  PriceBar,
  Quote,
  ResearchResult,
} from '@bourse/analysis';
import { EvidencePackV2 as EvidencePackV2Schema } from '@bourse/analysis';
import { SnapshotV2Service } from './snapshot-v2.service';

// Note: This test uses the production SnapshotV2Service which calls
// real CN tool descriptors (consensusEpsCN / lhbScanCN /
// akshareNorthboundCN / unlockCalendarCN / shareholdersCN). Those tools
// rely on `globalThis.fetch` when no custom fetchImpl is provided. To
// avoid live network we install a global fetch mock for the test run.

// ============================================================================
// Helpers
// ============================================================================

function envelope<T>(data: T): ResearchResult<T> {
  return {
    schemaVersion: '1.0',
    data,
    citations: [],
    freshness: [],
    warnings: [],
  } as unknown as ResearchResult<T>;
}

function aaplQuote(): Quote {
  return {
    instrument: { instrumentId: 'US:AAPL', market: 'US', symbol: 'AAPL' },
    price: 200,
    currency: 'USD',
    timestamp: '2025-05-25T00:00:00.000Z',
    marketCap: 600_000_000_000,
    peRatio: 28.5,
  };
}

function maotaiQuote(): Quote {
  return {
    instrument: { instrumentId: 'CN:600519', market: 'CN', symbol: '600519' },
    price: 1685,
    currency: 'CNY',
    timestamp: '2025-05-25T00:00:00.000Z',
    marketCap: 21_000, // 亿元
  };
}

function bars(n: number, startClose = 100, step = 0.5): PriceBar[] {
  return Array.from({ length: n }, (_, i) => ({
    // Date-only timestamp (the shape real connectors emit). Forces the
    // technical-indicators normalizer to do its job — if the asOf
    // coercion regresses, this test catches it.
    timestamp: new Date(Date.UTC(2025, 0, i + 1)).toISOString().slice(0, 10),
    open: startClose + i * step,
    high: startClose + i * step + 1,
    low: startClose + i * step - 1,
    close: startClose + i * step,
    volume: 1_000_000,
  }));
}

function aaplFinancials(): FinancialsBundle {
  return {
    periods: [
      {
        fiscalPeriod: 'TTM',
        kind: 'TTM',
        fiscalYearEnd: '2025-03-31',
        filed: '2025-04-30',
        income: {
          revenue: { value: 100_000_000_000, unit: 'USD' },
          netIncome: { value: 20_000_000_000, unit: 'USD' },
        },
        balance: {
          totalAssets: { value: 350_000_000_000, unit: 'USD' },
          totalLiabilities: { value: 280_000_000_000, unit: 'USD' },
          totalStockholdersEquity: { value: 70_000_000_000, unit: 'USD' },
        },
        cashFlow: {
          operatingCashFlow: { value: 22_000_000_000, unit: 'USD' },
          freeCashFlow: { value: 18_000_000_000, unit: 'USD' },
        },
      },
    ],
    currency: 'USD',
    sourceUrl: 'https://sec.gov/x',
    retrievedAt: '2025-05-25T00:00:00.000Z',
    provider: 'sec-edgar-xbrl',
    qualityTier: 'A',
  };
}

function aaplFilings(): FilingSummary[] {
  return [
    { url: 'https://sec.gov/x.htm' } as unknown as FilingSummary,
    { url: 'https://sec.gov/y.htm' } as unknown as FilingSummary,
  ];
}

const SECONDS_IN_MS = 1_000;
// 动态近期日期：lhb/northbound 有 daysBack(30) 窗口过滤，硬编码日期会随时间
// 落出窗外 → appearances 被过滤 → facts 空（曾硬编码 '2026-05-10'，30 天后
// fail）。用 now-5d / now-3d 保持窗口内，测试不再时间敏感。
const lhbDate = new Date(Date.now() - 5 * 86_400_000).toISOString().slice(0, 10);
const nbDate = new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10);

// ============================================================================
// Fetch mock that responds to CN tool URLs
// ============================================================================

interface MockResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
}

function mockResponse(body: unknown, status = 200): MockResponse {
  const ok = status >= 200 && status < 300;
  return {
    ok,
    status,
    async text() {
      return JSON.stringify(body);
    },
    async json() {
      return body;
    },
  };
}

/** Pattern-match URL → response. Used as globalThis.fetch replacement. */
function installFetchMock(handlers: Array<[RegExp, () => MockResponse]>) {
  const original = globalThis.fetch;
  const stub = (async (url: string | URL) => {
    const u = typeof url === 'string' ? url : url.toString();
    for (const [pattern, builder] of handlers) {
      if (pattern.test(u)) return builder();
    }
    // Unhandled URL → simulate connection failure so tests don't silently hit live
    throw new Error(`mockFetch: unhandled URL ${u}`);
  }) as typeof fetch;
  globalThis.fetch = stub;
  return () => {
    globalThis.fetch = original;
  };
}

// ============================================================================
// Port stubs
// ============================================================================

function aaplProfile() {
  // Real Yahoo assetProfile shape projected to CompanyProfile.
  return {
    instrument: { instrumentId: 'US:AAPL', market: 'US' as const, symbol: 'AAPL' },
    description: 'Apple Inc. designs, manufactures, and markets smartphones.',
    sector: 'Technology',
    industry: 'Consumer Electronics',
    employees: 166_000,
    website: 'https://www.apple.com',
  };
}

function maotaiProfile() {
  // Real Eastmoney F10 RPT_F10_BASIC_ORGINFO shape projected to CompanyProfile.
  return {
    instrument: { instrumentId: 'CN:600519', market: 'CN' as const, symbol: '600519' },
    description: '贵州茅台酒股份有限公司成立于1999年。',
    sector: '食品饮料',
    industry: '白酒',
    employees: 34_992,
    website: 'www.moutaichina.com',
  };
}

function mockYahoo(): FinancePort {
  return {
    async getQuote() {
      return envelope(aaplQuote());
    },
    async getHistory() {
      return envelope(bars(250));
    },
    async getProfile() {
      return envelope(aaplProfile());
    },
  } as unknown as FinancePort;
}

function mockCnFinance(): FinancePort {
  return {
    async getQuote() {
      return envelope(maotaiQuote());
    },
    async getHistory() {
      return envelope([]);
    },
    async getProfile() {
      return envelope(maotaiProfile());
    },
  } as unknown as FinancePort;
}

function mockFinancials(returnVal: FinancialsBundle | null = aaplFinancials()): FinancialsPort {
  return {
    async fetchFinancials() {
      return envelope(returnVal);
    },
  } as unknown as FinancialsPort;
}

function mockFilings(returnVal: FilingSummary[] = aaplFilings()): FilingPort {
  return {
    async searchFilings() {
      return envelope(returnVal);
    },
    async getFiling() {
      return envelope(null);
    },
  } as unknown as FilingPort;
}

function buildService(
  overrides: {
    yahoo?: FinancePort;
    cn?: FinancePort;
    usFinancials?: FinancialsPort;
    cnFinancials?: FinancialsPort;
    hkFinancials?: FinancialsPort;
    usFilings?: FilingPort;
    cnFilings?: FilingPort;
  } = {},
): SnapshotV2Service {
  return new SnapshotV2Service(
    overrides.yahoo ?? mockYahoo(),
    overrides.cn ?? mockCnFinance(),
    overrides.usFinancials ?? mockFinancials(),
    overrides.cnFinancials ?? mockFinancials(null),
    overrides.hkFinancials ?? mockFinancials(null),
    overrides.usFilings ?? mockFilings(),
    overrides.cnFilings ?? mockFilings([]),
  );
}

// ============================================================================
// E2E tests
// ============================================================================

describe('SnapshotV2 · E2E (US AAPL full coverage)', () => {
  it('produces a valid EvidencePackV2 with quote + financials + filings + computed ratios', async (t) => {
    // No CN tools are invoked for US, but we still install the mock to be
    // safe (any leaked CN tool call throws — surfaces wiring bugs fast).
    const cleanup = installFetchMock([
      [/eastmoney|qt\.gtimg|push2/i, () => mockResponse({ result: { data: [] } })],
    ]);
    t.after(cleanup);

    const svc = buildService();
    const pack = await svc.fetchAsEvidencePack('AAPL', 'US', {
      perConnectorTimeoutMs: 2 * SECONDS_IN_MS,
    });

    // Schema valid
    const r = EvidencePackV2Schema.safeParse(pack);
    if (!r.success) {
      console.error('US schema errors:', JSON.stringify(r.error.errors, null, 2));
    }
    assert.equal(r.success, true);

    // Coverage
    assert.equal(pack.facts.quote?.value, 200);
    assert.equal(pack.facts.marketCap?.value, 600_000_000_000);
    assert.equal(pack.facts.currency?.value, 'USD');
    assert.equal(pack.facts.pe?.value, 28.5);
    // profile projected from Yahoo assetProfile
    assert.equal(pack.facts.profile?.value.sector, 'Technology');
    assert.equal(pack.facts.profile?.value.industry, 'Consumer Electronics');
    assert.equal(pack.facts.profile?.value.employees, 166_000);
    assert.ok(pack.dataAvailability.complete.includes('profile'));
    assert.equal(pack.facts.financials?.value.periods.length, 1);
    assert.deepEqual(pack.facts.latestFilingUrls?.value, [
      'https://sec.gov/x.htm',
      'https://sec.gov/y.htm',
    ]);

    // Compute layer fired
    assert.ok(pack.computedFacts);
    assert.notEqual(pack.computedFacts?.ratios, null);
    assert.ok((pack.computedFacts?.ratios?.pe ?? 0) > 0);
    assert.notEqual(pack.computedFacts?.technical, null);
  });
});

describe('SnapshotV2 · E2E (CN 600519 with mocked CN tools)', () => {
  it('CN tools succeed → pack carries consensusEps/lhb/northbound/unlock', async (t) => {
    const cleanup = installFetchMock([
      // consensusEps — agent tool uses RPT_RES_CONFORECASTPREDATA (legacy
      // endpoint name; production code path hasn't been switched to the
      // verified-live RPT_RES_PROFITPREDICT yet — separate cleanup item).
      [
        // consensus EPS — live report RPT_WEB_RESPREDICT (one row, YEARn/EPSn)
        /RPT_WEB_RESPREDICT/i,
        () =>
          mockResponse({
            result: {
              data: [
                { YEAR1: 2026, EPS1: 68.96, YEAR2: 2027, EPS2: 72.75, RATING_ORG_NUM: 5 },
              ],
            },
          }),
      ],
      // LHB
      [
        /RPT_DAILYBILLBOARD_DETAILS/i,
        () =>
          mockResponse({
            result: {
              data: [
                {
                  TRADE_DATE: `${lhbDate} 00:00:00`,
                  EXPLANATION: '换手率达20%',
                  OPERATEDEPT_NAME: '国泰君安上海江苏路',
                  BUY: 1.2e7,
                  SELL: 0,
                  NET: 1.2e7,
                  BILLBOARD_BUY_AMT: 1.2e7,
                  BILLBOARD_SELL_AMT: 0,
                  BILLBOARD_NET_AMT: 1.2e7,
                  BILLBOARD_DEAL_AMT: 1.2e7,
                  CLOSE_PRICE: 1685,
                  CHANGE_RATE: 8.5,
                  TURNOVERRATE: 0.04,
                },
              ],
            },
          }),
      ],
      // Northbound — akshare path uses RPT_MUTUAL_HOLDSTOCKNORTH_STA
      [
        /RPT_MUTUAL_HOLDSTOCKNORTH_STA/i,
        () =>
          mockResponse({
            result: {
              data: [
                {
                  HOLD_DATE: nbDate,
                  MUTUAL_TYPE: '1',
                  ADD_MARKET_CAP: 5.5,
                  HOLD_SHARES_NUM: 4_800_000,
                  HOLD_MARKET_CAP: 95.6,
                  SHARES_HOLDRATIO: 5.32,
                },
              ],
            },
          }),
      ],
      // unlockCalendar — live report RPT_LIFT_STAGE (FREE_DATE / FREE_SHARES
      // [万股] / LIFT_MARKET_CAP [万元] / FREE_SHARES_TYPE). FREE_SHARES 500万股
      // → 5,000,000 股. Date within the default 90-day window.
      [
        /RPT_LIFT_STAGE/i,
        () => {
          const d = new Date(Date.now() + 30 * 86_400_000);
          return mockResponse({
            result: {
              data: [
                {
                  FREE_DATE: d.toISOString().slice(0, 10),
                  FREE_SHARES: 500,
                  LIFT_MARKET_CAP: 12_000,
                  FREE_RATIO: 0.11,
                  FREE_SHARES_TYPE: '首发原股东限售股',
                },
              ],
            },
          });
        },
      ],
      // Shareholders (RPT_F10_EH_HOLDERNUM)
      [
        /RPT_F10_EH_HOLDERNUM/i,
        () =>
          mockResponse({
            result: {
              data: [
                {
                  SECURITY_CODE: '600519',
                  END_DATE: '2026-03-31',
                  HOLDER_TOTAL_NUM: 242_750,
                  HOLDER_TOTAL_NUMCHANGE: -13_220,
                  CHANGEWITHLAST: -5.17,
                  AVG_HOLD_AMT: 7_320_000,
                  AVG_FREE_SHARES: 4500,
                  HOLD_FOCUS: '集中',
                },
              ],
            },
          }),
      ],
      // Default fallback for any unmatched eastmoney URL
      [/eastmoney|push2/i, () => mockResponse({ result: { data: [] } })],
    ]);
    t.after(cleanup);

    const svc = buildService();
    const pack = await svc.fetchAsEvidencePack('600519', 'CN', {
      perConnectorTimeoutMs: 3 * SECONDS_IN_MS,
    });

    // Schema valid
    const r = EvidencePackV2Schema.safeParse(pack);
    if (!r.success) {
      console.error(JSON.stringify(r.error.errors, null, 2));
    }
    assert.equal(r.success, true);

    // All 4 CN-only fact keys land
    assert.ok(pack.facts.consensusEps, 'consensusEps should be populated');
    assert.ok(pack.facts.lhbAppearances, 'lhbAppearances should be populated');
    assert.ok(pack.facts.northboundFlow, 'northboundFlow should be populated');
    assert.ok(pack.facts.unlockCalendar, 'unlockCalendar should be populated');

    // CN tool data shape sanity
    assert.equal(pack.facts.consensusEps?.value?.[0]?.year, 2026);
    assert.equal(pack.facts.consensusEps?.value?.[0]?.value, 68.96);
    assert.equal(pack.facts.lhbAppearances?.value?.[0]?.date, lhbDate);
    assert.deepEqual(pack.facts.lhbAppearances?.value?.[0]?.topBuySeats, [
      '国泰君安上海江苏路',
    ]);
    assert.equal(pack.facts.northboundFlow?.value?.[0]?.hgt, 5.5);
    assert.equal(pack.facts.unlockCalendar?.value?.[0]?.shares, 5_000_000);

    // quote from mock CN finance port
    assert.equal(pack.facts.quote?.value, 1685);
    assert.equal(pack.facts.currency?.value, 'CNY');

    // profile projected from Eastmoney F10 基本资料
    assert.ok(pack.facts.profile, 'profile should be populated');
    assert.equal(pack.facts.profile?.value.sector, '食品饮料');
    assert.equal(pack.facts.profile?.value.industry, '白酒');
    assert.equal(pack.facts.profile?.value.employees, 34_992);
    assert.ok(pack.dataAvailability.complete.includes('profile'));
  });

  it('CN tools all fail → pack has rate_limited/not_implemented/timeout reasons (NOT silently empty)', async (t) => {
    const cleanup = installFetchMock([
      // Every CN endpoint returns 429
      [
        /eastmoney|push2/i,
        () =>
          mockResponse(
            { detail: { error: 'rate limited' } },
            429,
          ),
      ],
    ]);
    t.after(cleanup);

    const svc = buildService();
    const pack = await svc.fetchAsEvidencePack('600519', 'CN', {
      perConnectorTimeoutMs: 2 * SECONDS_IN_MS,
    });

    // Schema valid
    assert.equal(EvidencePackV2Schema.safeParse(pack).success, true);

    // None of the CN-only fact keys populated
    assert.equal(pack.facts.consensusEps, undefined);
    assert.equal(pack.facts.lhbAppearances, undefined);
    assert.equal(pack.facts.northboundFlow, undefined);
    assert.equal(pack.facts.unlockCalendar, undefined);

    // dataAvailability.missing entries carry rate_limited (NOT silently
    // dropped). The reason string includes the structured code from the
    // adapter ("rate_limited: ...detail...").
    const missingFields = pack.dataAvailability.missing.map((m) => m.field);
    for (const cnTool of ['consensusEps', 'lhb', 'northboundFlow', 'unlockCalendar', 'shareholders']) {
      assert.ok(
        missingFields.includes(cnTool),
        `${cnTool} should be in missing[], got [${missingFields.join(',')}]`,
      );
    }
    const consensusMiss = pack.dataAvailability.missing.find((m) => m.field === 'consensusEps');
    assert.match(consensusMiss?.reason ?? '', /rate_limited|retry-after/i);
  });
});
