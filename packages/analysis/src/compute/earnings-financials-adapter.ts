import Decimal from 'decimal.js';
import { MetricFactSchema, type MetricFact } from '../contracts/earnings';
import type {
  FinancialsBundle,
  FinancialsLineItem,
  FinancialsPeriodEntry,
} from '../ports/financials';
import { normalize } from './units';

const FIELD_PATHS: Partial<
  Record<MetricFact['metricCode'], { group: 'income' | 'balance' | 'cashFlow'; field: string }>
> = {
  revenue: { group: 'income', field: 'revenue' },
  costOfRevenue: { group: 'income', field: 'costOfRevenue' },
  grossProfit: { group: 'income', field: 'grossProfit' },
  operatingIncome: { group: 'income', field: 'operatingIncome' },
  netIncome: { group: 'income', field: 'netIncome' },
  epsDiluted: { group: 'income', field: 'eps' },
  operatingCashFlow: { group: 'cashFlow', field: 'operatingCashFlow' },
  capitalExpenditures: { group: 'cashFlow', field: 'capitalExpenditures' },
  freeCashFlow: { group: 'cashFlow', field: 'freeCashFlow' },
  totalAssets: { group: 'balance', field: 'totalAssets' },
  totalLiabilities: { group: 'balance', field: 'totalLiabilities' },
  totalEquity: { group: 'balance', field: 'totalStockholdersEquity' },
  cashAndCashEquivalents: { group: 'balance', field: 'cashAndCashEquivalents' },
};

/**
 * Projects structured statements onto already-source-anchored filing facts.
 * The filing fact is the semantic template, so this adapter never invents a
 * period/scope identity from an underspecified provider row.
 */
export function financialsToComparableFacts(
  bundle: FinancialsBundle,
  filingFacts: MetricFact[],
): MetricFact[] {
  const out: MetricFact[] = [];
  for (const template of filingFacts) {
    const path = FIELD_PATHS[template.metricCode];
    if (!path) continue;
    const period = findComparablePeriod(bundle.periods, template);
    if (!period) continue;
    const line = readLine(period, path.group, path.field);
    if (!line) continue;
    const normalized = normalize(line.value, line.unit, template.metricCode);
    if (normalized.value === null || normalized.warning) continue;

    const value = new Decimal(normalized.value).toString();
    out.push(
      MetricFactSchema.parse({
        ...template,
        id: `${template.id}:${bundle.provider}`,
        value: { kind: 'scalar', value },
        normalizedValue: { kind: 'scalar', value },
        scale: 1,
        provenance: {
          kind: 'structuredSource',
          provider: bundle.provider,
          sourceUrl: bundle.sourceUrl,
          fieldPath: `${period.fiscalPeriod}.${path.group}.${path.field}`,
          asOf: bundle.retrievedAt,
        },
        comparisons: [],
        checkStatus: { status: 'passed', checks: ['structured_schema'] },
        reconcileStatus: { status: 'not_applicable', reason: 'comparison_source' },
      }),
    );
  }
  return out;
}

export interface StructuredEarningsProjection {
  periodEndOn: string;
  periodType: 'Q1' | 'Q2' | 'Q3' | 'H1' | 'FY';
  fiscalYear: number;
  fiscalQuarter?: number;
  facts: MetricFact[];
}

/** Produces a source-labelled fallback card when filing text is unreadable. */
export function latestFinancialsToStructuredProjection(
  bundle: FinancialsBundle,
): StructuredEarningsProjection | null {
  const period = bundle.periods.find((entry) => entry.kind !== 'TTM');
  if (!period) return null;
  const match = /^(Q([1-4])-FY|FY)(\d{4})$/.exec(period.fiscalPeriod);
  if (!match) return null;
  const fiscalYear = Number(match[3]);
  const quarter = match[2] ? Number(match[2]) : undefined;
  const periodType = quarter && quarter <= 3 ? (`Q${quarter}` as 'Q1' | 'Q2' | 'Q3') : 'FY';
  const facts: MetricFact[] = [];

  for (const [metricCode, path] of Object.entries(FIELD_PATHS) as Array<
    [MetricFact['metricCode'], NonNullable<(typeof FIELD_PATHS)[MetricFact['metricCode']]>]
  >) {
    const line = readLine(period, path.group, path.field);
    if (!line) continue;
    const normalized = normalize(line.value, line.unit, metricCode);
    if (normalized.value === null || normalized.warning) continue;
    const isBalance = path.group === 'balance';
    const isPerShare = metricCode === 'epsDiluted' || metricCode === 'epsBasic';
    const value = new Decimal(normalized.value).toString();
    facts.push(
      MetricFactSchema.parse({
        id: `structured:${bundle.provider}:${period.fiscalPeriod}:${metricCode}`,
        metricCode,
        value: { kind: 'scalar', value },
        normalizedValue: { kind: 'scalar', value },
        unit: isPerShare ? 'per_share' : 'currency',
        currency: bundle.currency,
        scale: 1,
        periodEndOn: period.fiscalYearEnd,
        periodKind: isBalance ? 'instant' : 'duration',
        accumulation: isBalance ? 'discrete' : period.kind === 'FY' ? 'FY' : 'discrete',
        accountingBasis: bundle.provider === 'sec-edgar-xbrl' ? 'US-GAAP' : 'CAS',
        consolidationScope: 'consolidated',
        derivation: { kind: 'reported' },
        provenance: {
          kind: 'structuredSource',
          provider: bundle.provider,
          sourceUrl: bundle.sourceUrl,
          fieldPath: `${period.fiscalPeriod}.${path.group}.${path.field}`,
          asOf: bundle.retrievedAt,
        },
        comparisons: [],
        checkStatus: { status: 'passed', checks: ['structured_schema'] },
        reconcileStatus: { status: 'not_applicable', reason: 'filing_text_unavailable' },
      }),
    );
  }
  return {
    periodEndOn: period.fiscalYearEnd,
    periodType,
    fiscalYear,
    ...(quarter ? { fiscalQuarter: quarter } : {}),
    facts,
  };
}

function findComparablePeriod(
  periods: FinancialsPeriodEntry[],
  fact: MetricFact,
): FinancialsPeriodEntry | null {
  const candidates = periods.filter(
    (period) => period.kind !== 'TTM' && period.fiscalYearEnd === fact.periodEndOn,
  );
  if (fact.periodKind === 'instant') return candidates[0] ?? null;
  if (fact.accumulation === 'FY') {
    return candidates.find((period) => period.kind === 'FY') ?? null;
  }
  if (fact.accumulation === 'discrete') {
    return candidates.find((period) => period.kind === 'Q') ?? null;
  }
  // Q1 YTD and discrete are equivalent. H1/9M require cumulative source rows,
  // which FinancialsBundle intentionally does not expose today.
  if (fact.accumulation === 'YTD' && /Q1-/i.test(candidates[0]?.fiscalPeriod ?? '')) {
    return candidates.find((period) => period.kind === 'Q') ?? null;
  }
  return null;
}

function readLine(
  period: FinancialsPeriodEntry,
  group: 'income' | 'balance' | 'cashFlow',
  field: string,
): FinancialsLineItem | null {
  const record = period[group] as unknown as Record<string, FinancialsLineItem | undefined>;
  return record[field] ?? null;
}
