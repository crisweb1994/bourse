import { describe, expect, it } from 'vitest';
import type { FetchLike } from '../types';
import type { CikLookup } from '../filings/cik-lookup';
import { FinancialsBundleV2Schema } from '../../ports/financials-v2';
import { createSecEdgarXbrlV2FinancialsConnector } from './sec-edgar-xbrl-v2';

type Fp = 'FY' | 'Q1' | 'Q2' | 'Q3' | 'Q4';

function fact(opts: {
  fy: number;
  fp: Fp;
  val: number;
  end: string;
  filed: string;
  accn: string;
  start?: string;
  form?: string;
  dimensions?: Record<string, unknown>;
}) {
  return {
    ...(opts.start ? { start: opts.start } : {}),
    end: opts.end,
    val: opts.val,
    accn: opts.accn,
    fy: opts.fy,
    fp: opts.fp,
    form: opts.form ?? (opts.fp === 'FY' ? '10-K' : '10-Q'),
    filed: opts.filed,
    ...(opts.dimensions ? { dimensions: opts.dimensions } : {}),
  };
}

function concept(units: Record<string, ReturnType<typeof fact>[]>) {
  return { units };
}

function buildUsGaapFixture() {
  return {
    cik: 1234567,
    entityName: 'Fixture Corp',
    facts: {
      'us-gaap': {
        RevenueFromContractWithCustomerExcludingAssessedTax: concept({
          USD: [
            fact({ fy: 2024, fp: 'FY', val: 100_000, start: '2024-01-01', end: '2024-12-31', filed: '2025-02-01', accn: 'acc-fy' }),
            fact({ fy: 2025, fp: 'Q1', val: 25_000, start: '2025-01-01', end: '2025-03-31', filed: '2025-05-01', accn: 'acc-q1' }),
            // 10-Q 同期比较列：companyfacts 会标成当前 fy/fp（frame 才是真实期间），
            // 必须按 end == periodEndOn 排除，否则与当前期事实撞 revision 身份。
            fact({ fy: 2025, fp: 'Q1', val: 22_000, start: '2024-01-01', end: '2024-03-31', filed: '2025-05-01', accn: 'acc-q1' }),
            // 防御性维度事实：必须被排除。
            fact({
              fy: 2025,
              fp: 'Q1',
              val: 15_000,
              end: '2025-03-31',
              filed: '2025-05-01',
              accn: 'acc-q1-segment',
              dimensions: { 'us-gaap:StatementBusinessSegmentsAxis': 'us-gaap:SegmentOne' },
            }),
          ],
        }),
        Revenues: concept({
          USD: [fact({ fy: 2022, fp: 'FY', val: 50_000, end: '2022-12-31', filed: '2023-02-01', accn: 'acc-fy2022' })],
        }),
        CostOfRevenue: concept({
          USD: [
            fact({ fy: 2024, fp: 'FY', val: 60_000, start: '2024-01-01', end: '2024-12-31', filed: '2025-02-01', accn: 'acc-fy' }),
            fact({ fy: 2025, fp: 'Q1', val: 15_000, start: '2025-01-01', end: '2025-03-31', filed: '2025-05-01', accn: 'acc-q1' }),
          ],
        }),
        NetIncomeLoss: concept({
          USD: [
            fact({ fy: 2024, fp: 'FY', val: 20_000, start: '2024-01-01', end: '2024-12-31', filed: '2025-02-01', accn: 'acc-fy' }),
            fact({ fy: 2025, fp: 'Q1', val: 5_000, start: '2025-01-01', end: '2025-03-31', filed: '2025-05-01', accn: 'acc-q1' }),
          ],
        }),
        NetIncomeLossAttributableToParent: concept({
          USD: [
            fact({ fy: 2024, fp: 'FY', val: 19_000, start: '2024-01-01', end: '2024-12-31', filed: '2025-02-01', accn: 'acc-fy' }),
            fact({ fy: 2025, fp: 'Q1', val: 4_800, start: '2025-01-01', end: '2025-03-31', filed: '2025-05-01', accn: 'acc-q1' }),
          ],
        }),
        EarningsPerShareBasic: concept({
          'USD/shares': [
            fact({ fy: 2024, fp: 'FY', val: 1.9, start: '2024-01-01', end: '2024-12-31', filed: '2025-02-01', accn: 'acc-fy' }),
            fact({ fy: 2025, fp: 'Q1', val: 0.48, start: '2025-01-01', end: '2025-03-31', filed: '2025-05-01', accn: 'acc-q1' }),
          ],
        }),
        EarningsPerShareDiluted: concept({
          'USD/shares': [
            fact({ fy: 2024, fp: 'FY', val: 1.88, start: '2024-01-01', end: '2024-12-31', filed: '2025-02-01', accn: 'acc-fy' }),
            fact({ fy: 2025, fp: 'Q1', val: 0.47, start: '2025-01-01', end: '2025-03-31', filed: '2025-05-01', accn: 'acc-q1' }),
          ],
        }),
        NetCashProvidedByUsedInOperatingActivities: concept({
          USD: [
            fact({ fy: 2024, fp: 'FY', val: 30_000, start: '2024-01-01', end: '2024-12-31', filed: '2025-02-01', accn: 'acc-fy' }),
            fact({ fy: 2025, fp: 'Q1', val: 8_000, start: '2025-01-01', end: '2025-03-31', filed: '2025-05-01', accn: 'acc-q1' }),
          ],
        }),
        PaymentsToAcquirePropertyPlantAndEquipment: concept({
          USD: [
            fact({ fy: 2024, fp: 'FY', val: 5_000, start: '2024-01-01', end: '2024-12-31', filed: '2025-02-01', accn: 'acc-fy' }),
            fact({ fy: 2025, fp: 'Q1', val: 1_000, start: '2025-01-01', end: '2025-03-31', filed: '2025-05-01', accn: 'acc-q1' }),
          ],
        }),
        Assets: concept({
          USD: [
            fact({ fy: 2024, fp: 'FY', val: 500_000, end: '2024-12-31', filed: '2025-02-01', accn: 'acc-fy' }),
            fact({ fy: 2025, fp: 'Q1', val: 510_000, end: '2025-03-31', filed: '2025-05-01', accn: 'acc-q1' }),
          ],
        }),
        Liabilities: concept({
          USD: [
            fact({ fy: 2024, fp: 'FY', val: 200_000, end: '2024-12-31', filed: '2025-02-01', accn: 'acc-fy' }),
            fact({ fy: 2025, fp: 'Q1', val: 205_000, end: '2025-03-31', filed: '2025-05-01', accn: 'acc-q1' }),
          ],
        }),
        StockholdersEquity: concept({
          USD: [
            fact({ fy: 2024, fp: 'FY', val: 300_000, end: '2024-12-31', filed: '2025-02-01', accn: 'acc-fy' }),
            fact({ fy: 2025, fp: 'Q1', val: 305_000, end: '2025-03-31', filed: '2025-05-01', accn: 'acc-q1' }),
          ],
        }),
        CashAndCashEquivalentsAtCarryingValue: concept({
          USD: [
            fact({ fy: 2024, fp: 'FY', val: 40_000, end: '2024-12-31', filed: '2025-02-01', accn: 'acc-fy' }),
            fact({ fy: 2025, fp: 'Q1', val: 45_000, end: '2025-03-31', filed: '2025-05-01', accn: 'acc-q1' }),
          ],
        }),
      },
    },
  };
}

function buildIfrsFixture() {
  return {
    cik: 7654321,
    entityName: 'Foreign Filer PLC',
    facts: {
      'ifrs-full': {
        Revenue: concept({
          USD: [fact({ fy: 2024, fp: 'FY', val: 80_000, start: '2024-01-01', end: '2024-12-31', filed: '2025-03-01', accn: 'ifrs-fy' })],
        }),
        ProfitLoss: concept({
          USD: [fact({ fy: 2024, fp: 'FY', val: 12_000, start: '2024-01-01', end: '2024-12-31', filed: '2025-03-01', accn: 'ifrs-fy' })],
        }),
        ProfitLossAttributableToOwnersOfParent: concept({
          USD: [fact({ fy: 2024, fp: 'FY', val: 11_500, start: '2024-01-01', end: '2024-12-31', filed: '2025-03-01', accn: 'ifrs-fy' })],
        }),
        Assets: concept({
          USD: [fact({ fy: 2024, fp: 'FY', val: 400_000, end: '2024-12-31', filed: '2025-03-01', accn: 'ifrs-fy' })],
        }),
        Liabilities: concept({
          USD: [fact({ fy: 2024, fp: 'FY', val: 150_000, end: '2024-12-31', filed: '2025-03-01', accn: 'ifrs-fy' })],
        }),
        Equity: concept({
          USD: [fact({ fy: 2024, fp: 'FY', val: 250_000, end: '2024-12-31', filed: '2025-03-01', accn: 'ifrs-fy' })],
        }),
        NetCashFlowsFromUsedInOperatingActivities: concept({
          USD: [fact({ fy: 2024, fp: 'FY', val: 18_000, start: '2024-01-01', end: '2024-12-31', filed: '2025-03-01', accn: 'ifrs-fy' })],
        }),
        PaymentsToAcquirePropertyPlantAndEquipment: concept({
          USD: [fact({ fy: 2024, fp: 'FY', val: 2_000, start: '2024-01-01', end: '2024-12-31', filed: '2025-03-01', accn: 'ifrs-fy' })],
        }),
      },
    },
  };
}

/** 非自然财年（FYE 9/30）：Q2 单季 start=2025-01-01 不得被误标为 YTD。 */
function buildNonCalendarFixture() {
  return {
    cik: 999999,
    entityName: 'Non Calendar Corp',
    facts: {
      'us-gaap': {
        RevenueFromContractWithCustomerExcludingAssessedTax: concept({
          USD: [
            fact({ fy: 2025, fp: 'FY', val: 400_000, start: '2024-10-01', end: '2025-09-30', filed: '2025-11-15', accn: 'acc-fy' }),
            fact({ fy: 2025, fp: 'Q1', val: 90_000, start: '2024-10-01', end: '2024-12-31', filed: '2025-02-15', accn: 'acc-q1' }),
            fact({ fy: 2025, fp: 'Q2', val: 100_000, start: '2025-01-01', end: '2025-03-31', filed: '2025-05-15', accn: 'acc-q2' }),
            fact({ fy: 2025, fp: 'Q2', val: 190_000, start: '2024-10-01', end: '2025-03-31', filed: '2025-05-15', accn: 'acc-q2' }),
          ],
        }),
      },
    },
  };
}

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
            '0': { cik_str: 1234567, ticker: 'FIXT', title: 'Fixture Corp' },
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
const NOW = new Date('2025-06-01T00:00:00.000Z');

function makeConnector(companyfactsJson: unknown, status = 200) {
  const fetchLike = makeFetch({ companyfactsJson, companyfactsStatus: status });
  const connector = createSecEdgarXbrlV2FinancialsConnector({
    userAgent: fixedUserAgent,
    fetchLike,
    now: () => NOW,
  });
  return connector;
}

describe('sec-edgar-xbrl-v2 — us-gaap happy path', () => {
  it('builds a valid financials-v2 bundle with per-fact provenance', async () => {
    const connector = makeConnector(buildUsGaapFixture());
    const result = await connector.fetchFinancials({ instrumentId: 'US:FIXT', deriveTTM: false });

    expect(result.data).not.toBeNull();
    const bundle = result.data!;
    expect(bundle.schemaVersion).toBe('financials-v2');
    expect(bundle.provider).toBe('sec-edgar-xbrl-v2');
    expect(bundle.qualityTier).toBe('A');
    expect(bundle.sourceNature).toBe('official_structured');
    expect(() => FinancialsBundleV2Schema.parse(bundle)).not.toThrow();

    const fy2024 = bundle.periods.find((period) => period.id === 'period-2024-FY')!;
    expect(fy2024).toBeDefined();
    const revenue = fy2024.facts.find((fact) => fact.metricCode === 'revenue')!;
    expect(revenue.value).toBe('100000');
    expect(revenue.accumulation).toBe('FY');
    expect(revenue.provenance.sourceField).toBe(
      'RevenueFromContractWithCustomerExcludingAssessedTax',
    );
    expect(revenue.provenance.accessionNumber).toBe('acc-fy');
    expect(revenue.provenance.sourceFiledAt).toBe('2025-02-01T00:00:00.000Z');
  });

  it('labels Q1 duration facts as YTD and excludes dimensioned facts', async () => {
    const connector = makeConnector(buildUsGaapFixture());
    const result = await connector.fetchFinancials({ instrumentId: 'US:FIXT', deriveTTM: false });
    const q1 = result.data!.periods.find((period) => period.id === 'period-2025-Q1')!;
    const revenueFacts = q1.facts.filter((fact) => fact.metricCode === 'revenue');
    expect(revenueFacts).toHaveLength(1);
    expect(revenueFacts[0].value).toBe('25000');
    expect(revenueFacts[0].accumulation).toBe('YTD');
  });

  it('maps EPS basic and diluted separately', async () => {
    const connector = makeConnector(buildUsGaapFixture());
    const result = await connector.fetchFinancials({ instrumentId: 'US:FIXT', deriveTTM: false });
    const fy2024 = result.data!.periods.find((period) => period.id === 'period-2024-FY')!;
    const basic = fy2024.facts.find((fact) => fact.metricCode === 'epsBasic')!;
    const diluted = fy2024.facts.find((fact) => fact.metricCode === 'epsDiluted')!;
    expect(basic.value).toBe('1.9');
    expect(diluted.value).toBe('1.88');
    expect(basic.unit).toBe('per_share');
    expect(diluted.currency).toBe('USD');
  });

  it('maps netIncomeAttrib without duplicating into netIncome', async () => {
    const connector = makeConnector(buildUsGaapFixture());
    const result = await connector.fetchFinancials({ instrumentId: 'US:FIXT', deriveTTM: false });
    const fy2024 = result.data!.periods.find((period) => period.id === 'period-2024-FY')!;
    const attrib = fy2024.facts.find((fact) => fact.metricCode === 'netIncomeAttrib')!;
    const netIncome = fy2024.facts.find((fact) => fact.metricCode === 'netIncome')!;
    expect(attrib.value).toBe('19000');
    expect(netIncome.value).toBe('20000');
    expect(attrib.provenance.sourceField).toBe('NetIncomeLossAttributableToParent');
  });

  it('derives FCF and grossProfit as computed facts with input fact IDs', async () => {
    const connector = makeConnector(buildUsGaapFixture());
    const result = await connector.fetchFinancials({ instrumentId: 'US:FIXT', deriveTTM: false });
    const fy2024 = result.data!.periods.find((period) => period.id === 'period-2024-FY')!;
    const fcf = fy2024.facts.find((fact) => fact.metricCode === 'freeCashFlow')!;
    const grossProfit = fy2024.facts.find((fact) => fact.metricCode === 'grossProfit')!;
    expect(fcf.derivation).toEqual({
      kind: 'computed',
      formula: 'ocf-minus-capex-v1',
      inputFactIds: expect.any(Array),
    });
    expect(fcf.value).toBe('25000');
    expect(grossProfit.derivation.kind).toBe('computed');
    expect(grossProfit.value).toBe('40000');
    const allIds = new Set(fy2024.facts.map((fact) => fact.id));
    for (const fact of [fcf, grossProfit]) {
      for (const inputId of fact.derivation.inputFactIds) {
        expect(allIds.has(inputId)).toBe(true);
      }
    }
  });

  it('emits instant balance facts without accumulation', async () => {
    const connector = makeConnector(buildUsGaapFixture());
    const result = await connector.fetchFinancials({ instrumentId: 'US:FIXT', deriveTTM: false });
    const fy2024 = result.data!.periods.find((period) => period.id === 'period-2024-FY')!;
    const assets = fy2024.facts.find((fact) => fact.metricCode === 'totalAssets')!;
    expect(assets.periodKind).toBe('instant');
    expect(assets.accumulation).toBeUndefined();
  });

  it('respects the years cap', async () => {
    const connector = makeConnector(buildUsGaapFixture());
    const result = await connector.fetchFinancials({
      instrumentId: 'US:FIXT',
      deriveTTM: false,
      years: 1,
    });
    const ids = result.data!.periods.map((period) => period.id);
    expect(ids).toContain('period-2024-FY');
    expect(ids).toContain('period-2025-Q1');
    expect(ids).not.toContain('period-2022-FY');
  });
});

describe('sec-edgar-xbrl-v2 — taxonomy', () => {
  it('supports ifrs-full filers', async () => {
    const connector = makeConnector(buildIfrsFixture());
    const result = await connector.fetchFinancials({ instrumentId: 'US:FIXT', deriveTTM: false });
    expect(result.data).not.toBeNull();
    const fy2024 = result.data!.periods.find((period) => period.id === 'period-2024-FY')!;
    expect(fy2024.accountingBasis).toBe('IFRS');
    const revenue = fy2024.facts.find((fact) => fact.metricCode === 'revenue')!;
    expect(revenue.provenance.sourceField).toBe('Revenue');
    expect(fy2024.facts.find((fact) => fact.metricCode === 'netIncomeAttrib')!.value).toBe('11500');
  });

  it('returns unsupported_taxonomy instead of treating empty data as no filings', async () => {
    const connector = makeConnector({
      cik: 1,
      entityName: 'No XBRL',
      facts: { dei: { EntityCommonStockSharesOutstanding: { units: { shares: [] } } } },
    });
    const result = await connector.fetchFinancials({ instrumentId: 'US:FIXT', deriveTTM: false });
    expect(result.data).toBeNull();
    expect(result.warnings[0].code).toBe('PARTIAL_DATA');
    expect(result.warnings[0].message).toContain('unsupported_taxonomy');
  });
});

describe('sec-edgar-xbrl-v2 — non-calendar fiscal year', () => {
  it('labels quarter-start facts as discrete when the fiscal year does not start Jan 1', async () => {
    const connector = makeConnector(buildNonCalendarFixture());
    const result = await connector.fetchFinancials({ instrumentId: 'US:FIXT', deriveTTM: false });
    expect(result.data).not.toBeNull();
    const q2 = result.data!.periods.find((period) => period.id === 'period-2025-Q2')!;
    expect(q2.periodEndOn).toBe('2025-03-31');
    const revenueFacts = q2.facts.filter((fact) => fact.metricCode === 'revenue');
    expect(revenueFacts).toHaveLength(2);
    const ytd = revenueFacts.find((fact) => fact.accumulation === 'YTD')!;
    const discrete = revenueFacts.find((fact) => fact.accumulation === 'discrete')!;
    expect(ytd.value).toBe('190000');
    expect(discrete.value).toBe('100000');
  });
});

describe('sec-edgar-xbrl-v2 — failure paths', () => {
  it('returns INVALID_INSTRUMENT for unknown tickers', async () => {
    const cikLookup: CikLookup = { resolve: async () => null };
    const connector = createSecEdgarXbrlV2FinancialsConnector({
      userAgent: fixedUserAgent,
      cikLookup,
      now: () => NOW,
    });
    const result = await connector.fetchFinancials({ instrumentId: 'US:NOPE', deriveTTM: false });
    expect(result.data).toBeNull();
    expect(result.warnings[0].code).toBe('INVALID_INSTRUMENT');
  });

  it('returns null data on 404 (no XBRL filings) without warnings', async () => {
    const connector = makeConnector(undefined, 404);
    const result = await connector.fetchFinancials({ instrumentId: 'US:FIXT', deriveTTM: false });
    expect(result.data).toBeNull();
    expect(result.warnings).toHaveLength(0);
  });

  it('rejects non-US instruments', async () => {
    const connector = makeConnector(buildUsGaapFixture());
    const result = await connector.fetchFinancials({ instrumentId: 'CN:600519', deriveTTM: false });
    expect(result.data).toBeNull();
    expect(result.warnings[0].code).toBe('UNSUPPORTED_MARKET');
  });
});
