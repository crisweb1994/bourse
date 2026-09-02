import { RESEARCH_SCHEMA_VERSION, type ResearchResult } from '../../contracts/result';
import type { ResearchCitation } from '../../contracts/research-citation';
import type { ResearchWarning } from '../../contracts/warning';
import { DecimalStringSchema } from '../../contracts/scalars';
import type { FinancialsInput } from '../../ports/financials';
import {
  FinancialsBundleV2Schema,
  FinancialPeriodSchema,
  type ProviderFinancialsV2Port,
  type FinancialFact,
  type FinancialPeriod,
  type FinancialsBundleV2,
  type FinancialMetricCode,
} from '../../ports/financials-v2';
import { parseInstrumentId } from '../../util/instrument-id';
import { decimalSubtract } from '../../util/exact-decimal';
import type { ConnectorRunContext, FetchLike } from '../types';
import { failure as httpFailure, resolveFetch, withTimeout } from '../http';
import {
  createInMemoryCikLookup,
  type CikLookup,
} from '../filings/cik-lookup';
import {
  hasDimensions,
  pickTaxonomy,
  V2_CONCEPTS,
  type V2MetricCode,
  type V2XbrlCompanyFacts,
  type V2XbrlConcept,
  type V2XbrlFactEntry,
  type XbrlTaxonomy,
} from './concept-mapping-v2';

/**
 * SEC EDGAR XBRL Company Facts connector — v2（structured-first earnings）。
 *
 * 与 v1（sec-edgar-xbrl.ts）的差异（docs/structured-first-earnings-architecture.md §8.1）：
 * - 双 taxonomy：`us-gaap` + `ifrs-full`（20-F/6-K 外国发行人），taxonomy
 *   未知返回 `unsupported_taxonomy`，不把空数据当成"公司无财报"；
 * - 输出 financials-v2 bundle：fact 级 provenance（concept/accession/filed）、
 *   duration/instant 与 accumulation（按 duration start 与财年起点判定 YTD）；
 * - EPS 拆 basic/diluted；`netIncomeAttrib` 单独映射；
 * - 不伪造现金流单季值：10-Q 现金流只保留 YTD/reported 事实；
 * - 派生值显式标记 computed + 公式 + 输入 fact IDs（FCF、缺失的 grossProfit）；
 * - companyfacts 不含维度化事实；若未来出现 `dimensions` 字段，防御性拒绝。
 *
 * 本 connector 不接 routing/runner（原子切换点之前不接生产主路径）。
 */

const PROVIDER = 'sec-edgar-xbrl-v2';
const COMPANYFACTS_URL = 'https://data.sec.gov/api/xbrl/companyfacts';
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_YEARS = 5;

export interface SecEdgarXbrlV2Options {
  /** SEC 强制要求 contact UA。Format: `App Name contact@example.com`。 */
  userAgent: string;
  cikLookup?: CikLookup;
  fetchLike?: FetchLike;
  timeoutMs?: number;
  now?: () => Date;
}

type PeriodKey = 'FY' | 'Q1' | 'Q2' | 'Q3' | 'Q4';

export function createSecEdgarXbrlV2FinancialsConnector(
  options: SecEdgarXbrlV2Options,
): ProviderFinancialsV2Port {
  if (!options.userAgent?.trim()) {
    throw new Error('sec-edgar-xbrl-v2 requires a non-empty userAgent (SEC compliance)');
  }
  const cikLookup =
    options.cikLookup ??
    createInMemoryCikLookup({
      userAgent: options.userAgent,
      ...(options.fetchLike ? { fetchLike: options.fetchLike } : {}),
    });
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = options.now ?? (() => new Date());

  return {
    async fetchFinancials(
      input: FinancialsInput,
      ctx: ConnectorRunContext = {},
    ): Promise<ResearchResult<FinancialsBundleV2 | null>> {
      const retrievedAt = now().toISOString();
      const parsed = parseInstrumentId(input.instrumentId);
      if (!parsed) {
        return failure(retrievedAt, 'INVALID_INSTRUMENT', `Invalid instrumentId: ${input.instrumentId}`);
      }
      if (parsed.market !== 'US') {
        return failure(
          retrievedAt,
          'UNSUPPORTED_MARKET',
          `sec-edgar-xbrl-v2 only handles US issuers; got ${parsed.market}`,
        );
      }
      const providerSymbol =
        ctx.resolvedInstrument?.instrumentId === parsed.raw
          ? ctx.resolvedInstrument.providerSymbol
          : parsed.symbol;

      const fetchLike = resolveFetch(ctx, options);

      let cik: { cik: string; name: string } | null;
      try {
        cik = await cikLookup.resolve(providerSymbol, ctx);
      } catch (err) {
        const message = (err as Error)?.message ?? String(err);
        return failure(retrievedAt, 'SOURCE_UNAVAILABLE', `CIK lookup failed: ${message}`, message);
      }
      if (!cik) {
        return failure(
          retrievedAt,
          'INVALID_INSTRUMENT',
          `${parsed.symbol} is not a US SEC filer (OTC/ADR tickers are not covered by EDGAR)`,
        );
      }

      const url = `${COMPANYFACTS_URL}/CIK${cik.cik}.json`;
      type FetchOutcome =
        | { facts: V2XbrlCompanyFacts }
        | { envelope: ResearchResult<FinancialsBundleV2 | null> };
      let outcome: FetchOutcome;
      try {
        outcome = await withTimeout<FetchOutcome>(ctx, timeoutMs, async (signal) => {
          const res = await fetchLike(url, {
            headers: { 'User-Agent': options.userAgent, Accept: 'application/json' },
            signal,
          });
          if (res.status === 404) {
            return {
              envelope: {
                schemaVersion: RESEARCH_SCHEMA_VERSION,
                data: null,
                citations: [],
                freshness: [{ provider: PROVIDER, asOf: retrievedAt, retrievedAt, stale: false }],
                warnings: [],
              },
            };
          }
          if (!res.ok) {
            return {
              envelope: failure(
                retrievedAt,
                res.status === 429 ? 'RATE_LIMITED'
                : res.status === 403 ? 'AUTH_REQUIRED'
                : 'SOURCE_UNAVAILABLE',
                `SEC XBRL companyfacts HTTP ${res.status}`,
                `HTTP ${res.status}`,
              ),
            };
          }
          return { facts: (await res.json()) as V2XbrlCompanyFacts };
        });
      } catch (err) {
        const message = (err as Error)?.message ?? String(err);
        return failure(retrievedAt, 'SOURCE_UNAVAILABLE', `SEC XBRL fetch error: ${message}`, message);
      }
      if ('envelope' in outcome) return outcome.envelope;

      const taxonomy = pickTaxonomy(outcome.facts.facts);
      if (!taxonomy) {
        return failure(
          retrievedAt,
          'PARTIAL_DATA',
          `unsupported_taxonomy: no us-gaap/ifrs-full revenue facts for ${parsed.symbol} (${cik.name})`,
        );
      }
      const concepts = outcome.facts.facts?.[taxonomy];
      if (!concepts) {
        return failure(retrievedAt, 'PARTIAL_DATA', `unsupported_taxonomy: empty ${taxonomy} for ${parsed.symbol}`);
      }

      const years = input.years ?? DEFAULT_YEARS;
      const snapshotId = `snap-${retrievedAt}-${cik.cik}`;
      const periods = buildPeriods(concepts, taxonomy, years, url, snapshotId, retrievedAt);
      if (periods.length === 0) {
        return failure(retrievedAt, 'PARTIAL_DATA', `no usable periods for ${parsed.symbol}`);
      }

      const bundle: FinancialsBundleV2 = FinancialsBundleV2Schema.parse({
        schemaVersion: 'financials-v2',
        instrumentId: `${parsed.market}:${parsed.symbol}`,
        provider: PROVIDER,
        sourceNature: 'official_structured',
        qualityTier: 'A',
        sourceUrl: url,
        retrievedAt,
        snapshotId,
        periods,
      });

      const citation: ResearchCitation = {
        title: `SEC EDGAR Company Facts: ${cik.name}`,
        url,
        sourceType: 'FILING',
        provider: PROVIDER,
        retrievedAt,
        qualityTier: 'A',
      };

      return {
        schemaVersion: RESEARCH_SCHEMA_VERSION,
        data: bundle,
        citations: [citation],
        freshness: [{ provider: PROVIDER, asOf: retrievedAt, retrievedAt, stale: false }],
        warnings: [],
      };
    },
  };
}

// ============================================================================
// Period building
// ============================================================================

function periodKeyOf(entry: V2XbrlFactEntry): PeriodKey | null {
  if (entry.fp === 'FY' || entry.fp === 'Q1' || entry.fp === 'Q2' || entry.fp === 'Q3' || entry.fp === 'Q4') {
    return entry.fp;
  }
  return null;
}

function anchorPeriods(
  concepts: Record<string, V2XbrlConcept>,
  taxonomy: XbrlTaxonomy,
): Map<string, V2XbrlFactEntry> {
  const byKey = new Map<string, V2XbrlFactEntry>();
  for (const name of V2_CONCEPTS.revenue[taxonomy]) {
    const concept = concepts[name];
    if (!concept) continue;
    for (const entries of Object.values(concept.units)) {
      for (const entry of entries) {
        if (hasDimensions(entry)) continue;
        if (!periodKeyOf(entry)) continue;
        const key = `${entry.fy}|${entry.fp}`;
        const existing = byKey.get(key);
        // 同一 (fy, fp) 可能混入 10-Q/10-K 的同期比较列（end 是去年同一期间）。
        // anchor 必须取"当前期间"：end 最大者优先，其次最新 filed。
        if (!existing || entry.end > existing.end || (entry.end === existing.end && entry.filed > existing.filed)) {
          byKey.set(key, entry);
        }
      }
    }
  }
  return byKey;
}

function classifyUnit(
  unit: string,
): { unit: 'currency' | 'per_share'; currency: string } | null {
  const perShare = /^([A-Z]{3})\/shares$/.exec(unit);
  if (perShare) return { unit: 'per_share', currency: perShare[1] };
  if (/^[A-Z]{3}$/.test(unit)) return { unit: 'currency', currency: unit };
  return null;
}

function fiscalYearStart(
  fy: number,
  anchors: Map<string, V2XbrlFactEntry>,
  concepts: Record<string, V2XbrlConcept>,
  taxonomy: XbrlTaxonomy,
): string | undefined {
  const fyAnchor = anchors.get(`${fy}|FY`);
  if (fyAnchor?.start) return fyAnchor.start;
  // 兜底：该财年无年报时，先找最新结束日（当前期间），再取同结束日事实里
  // 最早的 start。直接用"全局最早 start"会被 10-Q 同期比较列污染。
  let latestEnd: string | undefined;
  for (const name of V2_CONCEPTS.revenue[taxonomy]) {
    const concept = concepts[name];
    if (!concept) continue;
    for (const entries of Object.values(concept.units)) {
      for (const entry of entries) {
        if (entry.fy !== fy || !entry.start || hasDimensions(entry)) continue;
        if (!latestEnd || entry.end > latestEnd) latestEnd = entry.end;
      }
    }
  }
  let earliest: string | undefined;
  for (const name of V2_CONCEPTS.revenue[taxonomy]) {
    const concept = concepts[name];
    if (!concept) continue;
    for (const entries of Object.values(concept.units)) {
      for (const entry of entries) {
        if (entry.fy !== fy || !entry.start || entry.end !== latestEnd || hasDimensions(entry)) continue;
        if (!earliest || entry.start < earliest) earliest = entry.start;
      }
    }
  }
  return earliest;
}

function buildPeriods(
  concepts: Record<string, V2XbrlConcept>,
  taxonomy: XbrlTaxonomy,
  years: number,
  sourceUrl: string,
  snapshotId: string,
  retrievedAt: string,
): FinancialPeriod[] {
  const anchors = anchorPeriods(concepts, taxonomy);
  if (anchors.size === 0) return [];
  const fyEntries = [...anchors.values()].filter((entry) => entry.fp === 'FY');
  const maxFy = Math.max(
    ...(fyEntries.length > 0 ? fyEntries.map((entry) => entry.fy) : [...anchors.values()].map((entry) => entry.fy)),
  );
  const minFy = maxFy - years + 1;

  const selected = [...anchors.entries()]
    .filter(([, entry]) => entry.fy >= minFy)
    .sort((a, b) => {
      if (b[1].fy !== a[1].fy) return b[1].fy - a[1].fy;
      return fpRank(b[1].fp as PeriodKey) - fpRank(a[1].fp as PeriodKey);
    });

  const periods: FinancialPeriod[] = [];
  for (const [, anchor] of selected) {
    const fy = anchor.fy;
    const fp = anchor.fp as PeriodKey;
    const fyStart = fiscalYearStart(fy, anchors, concepts, taxonomy);
    const facts = extractFacts(
      concepts,
      taxonomy,
      { fy, fp },
      fyStart,
      anchor.end,
      sourceUrl,
      snapshotId,
      retrievedAt,
      `period-${fy}-${fp}`,
    );
    if (facts.length === 0) continue;
    periods.push(
      FinancialPeriodSchema.parse({
        id: `period-${fy}-${fp}`,
        fiscalYear: fy,
        fiscalPeriodType: fp,
        periodStartOn: anchor.start,
        periodEndOn: anchor.end,
        publishedAt: `${anchor.filed}T00:00:00.000Z`,
        formType: anchor.form,
        reportingScope: 'consolidated',
        accountingBasis: taxonomy === 'us-gaap' ? 'US-GAAP' : 'IFRS',
        revision: {
          kind: /\/A$/i.test(anchor.form) ? 'amended' : 'original',
        },
        facts,
      }),
    );
  }
  return periods;
}

function fpRank(fp: PeriodKey): number {
  return { FY: 5, Q4: 4, Q3: 3, Q2: 2, Q1: 1 }[fp];
}

function extractFacts(
  concepts: Record<string, V2XbrlConcept>,
  taxonomy: XbrlTaxonomy,
  period: { fy: number; fp: PeriodKey },
  fyStart: string | undefined,
  periodEndOn: string,
  sourceUrl: string,
  snapshotId: string,
  retrievedAt: string,
  periodId: string,
): FinancialFact[] {
  const facts: FinancialFact[] = [];
  for (const metric of Object.keys(V2_CONCEPTS) as V2MetricCode[]) {
    const isEps = metric === 'epsBasic' || metric === 'epsDiluted';
    for (const name of V2_CONCEPTS[metric][taxonomy]) {
      const concept = concepts[name];
      if (!concept) continue;
      const matched: FinancialFact[] = [];
      for (const [unit, entries] of Object.entries(concept.units)) {
        const classified = classifyUnit(unit);
        if (!classified) continue;
        if (isEps && classified.unit !== 'per_share') continue;
        if (!isEps && classified.unit !== 'currency') continue;
        for (const entry of entries) {
          if (entry.fy !== period.fy || entry.fp !== period.fp) continue;
          // companyfacts 会把 10-Q/10-K 中的同期比较列也标成当前 fy/fp（frame 才是
          // 真实期间）。只保留 end 等于当前 period 结束日的事实；同日不同 accession
          // 的重述/更正仍会保留（revision 区分），由 selector 按 cutoff 选择。
          if (entry.end !== periodEndOn) continue;
          if (hasDimensions(entry)) continue;
          const value = String(entry.val);
          if (!DecimalStringSchema.safeParse(value).success) continue;
          const periodKind = entry.start ? 'duration' : 'instant';
          const accumulation =
            periodKind === 'instant'
              ? undefined
              : period.fp === 'FY'
                ? 'FY'
                : fyStart && entry.start === fyStart
                  ? 'YTD'
                  : fyStart
                    ? 'discrete' // 财年起点已知：非起点一律 discrete（避免日历 1 月 1 日误判）
                    : entry.start === `${period.fy}-01-01` || period.fp === 'Q1'
                      ? 'YTD'
                      : 'discrete';
          matched.push({
            id: `${periodId}:${metric}:${entry.start ?? 'instant'}:${entry.end}:${accumulation ?? 'instant'}:${entry.accn ?? 'na'}`,
            metricCode: metric as FinancialMetricCode,
            value,
            unit: classified.unit,
            currency: classified.currency,
            scale: 1,
            periodKind,
            ...(entry.start ? { periodStartOn: entry.start } : {}),
            periodEndOn: entry.end,
            ...(accumulation !== undefined ? { accumulation } : {}),
            accountingBasis: taxonomy === 'us-gaap' ? 'US-GAAP' : 'IFRS',
            reportingScope: 'consolidated',
            derivation: { kind: 'reported' },
            provenance: {
              provider: PROVIDER,
              sourceNature: 'official_structured',
              qualityTier: 'A',
              sourceUrl,
              sourceField: name,
              ...(entry.accn ? { accessionNumber: entry.accn } : {}),
              sourceFiledAt: `${entry.filed}T00:00:00.000Z`,
              snapshotId,
              retrievedAt,
            },
          });
        }
      }
      // 该 metric 在此 period 第一个有可用值的 concept 胜出（保留全部 accession 修订）。
      if (matched.length > 0) {
        facts.push(...matched);
        break;
      }
    }
  }
  return addComputedFacts(facts);
}

function addComputedFacts(facts: FinancialFact[]): FinancialFact[] {
  const out = [...facts];
  const sameIdentity = (a: FinancialFact, b: FinancialFact): boolean =>
    a.periodKind === b.periodKind &&
    a.periodStartOn === b.periodStartOn &&
    a.periodEndOn === b.periodEndOn &&
    a.accumulation === b.accumulation &&
    a.currency === b.currency;

  const derive = (
    metric: 'freeCashFlow' | 'grossProfit',
    inputs: [FinancialFact, FinancialFact],
    formula: string,
  ): void => {
    const [a, b] = inputs;
    const already = out.some(
      (fact) => fact.metricCode === metric && sameIdentity(fact, a) && fact.derivation.kind === 'computed',
    );
    if (already) return;
    out.push({
      id: `${a.id}:computed:${metric}`,
      metricCode: metric,
      value: decimalSubtract(a.value, b.value),
      unit: a.unit,
      currency: a.currency,
      scale: 1,
      periodKind: a.periodKind,
      ...(a.periodStartOn ? { periodStartOn: a.periodStartOn } : {}),
      periodEndOn: a.periodEndOn,
      ...(a.accumulation !== undefined ? { accumulation: a.accumulation } : {}),
      accountingBasis: a.accountingBasis,
      reportingScope: a.reportingScope,
      derivation: { kind: 'computed', formula, inputFactIds: [a.id, b.id] },
      provenance: {
        provider: PROVIDER,
        sourceNature: 'official_structured',
        qualityTier: 'A',
        sourceUrl: a.provenance.sourceUrl,
        sourceField: `computed:${metric}:${formula}`,
        snapshotId: a.provenance.snapshotId,
        retrievedAt: a.provenance.retrievedAt,
      },
    });
  };

  for (const ocf of out.filter((fact) => fact.metricCode === 'operatingCashFlow' && fact.derivation.kind === 'reported')) {
    const capex = out.find(
      (fact) =>
        fact.metricCode === 'capitalExpenditures' &&
        fact.derivation.kind === 'reported' &&
        sameIdentity(fact, ocf),
    );
    if (capex) derive('freeCashFlow', [ocf, capex], 'ocf-minus-capex-v1');
  }
  for (const revenue of out.filter((fact) => fact.metricCode === 'revenue' && fact.derivation.kind === 'reported')) {
    const cost = out.find(
      (fact) =>
        fact.metricCode === 'costOfRevenue' &&
        fact.derivation.kind === 'reported' &&
        sameIdentity(fact, revenue),
    );
    if (cost && !out.some((fact) => fact.metricCode === 'grossProfit' && sameIdentity(fact, revenue))) {
      derive('grossProfit', [revenue, cost], 'revenue-minus-costOfRevenue-v1');
    }
  }
  return out;
}

function failure(
  retrievedAt: string,
  code: ResearchWarning['code'],
  message: string,
  cause?: string,
): ResearchResult<FinancialsBundleV2 | null> {
  return httpFailure<FinancialsBundleV2 | null>(PROVIDER, null, {
    retrievedAt,
    code,
    message,
    ...(cause ? { cause } : {}),
  });
}
