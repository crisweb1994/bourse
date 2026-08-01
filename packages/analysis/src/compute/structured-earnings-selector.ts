import Decimal from 'decimal.js';
import type {
  FinancialFact,
  FinancialPeriod,
  FinancialsBundleV2,
  FiscalPeriodType,
  FlowAccumulation,
  FinancialMetricCode,
} from '@bourse/market-data';
import {
  MetricFactSchema,
  type EarningsMetricCode,
  type MetricFact,
} from '../contracts/earnings';

/**
 * 事件感知的精确期间选择（docs/structured-first-earnings-architecture.md §7）。
 *
 * 纯函数：不联网、不落库；输入 bundle（financials-v2 快照）+ 事件身份，输出
 * ready/pending/ambiguous/unsupported + diagnostics。不退回旧期间，不做宽容匹配。
 *
 * 2026-08-01 开源简化：不做延迟分布实测；retryAt 为确定性保守默认
 * （US 下一个夜间批处理窗口 ≈ +12h，CN/HK +30min），生产调度器可覆盖。
 */

export type StructuredEarningsMarket = 'US' | 'CN' | 'HK';
export type ExpectedEarningsPeriodType = 'Q1' | 'Q2' | 'Q3' | 'H1' | '9M' | 'FY';
export type PendingReason =
  | 'no_exact_period'
  | 'no_compatible_period'
  | 'no_supported_facts';

export interface StructuredEarningsSelectionInput {
  bundle: FinancialsBundleV2;
  market: StructuredEarningsMarket;
  /** 可选：校验 bundle 与 EarningsEvent 的 instrument 一致（算法第 1 步）。 */
  expectedInstrumentId?: string;
  expectedPeriodEndOn: string;
  expectedPeriodType: ExpectedEarningsPeriodType;
  /** 非自然财年/53 周财年：事件期所属财年与 issuer 日历标识（本期仅记录诊断，不做宽容匹配）。 */
  expectedFiscalYear?: number;
  fiscalCalendarId?: string;
  expectedAccountingBasis?: 'US-GAAP' | 'IFRS' | 'CAS' | 'HKFRS';
  expectedScope?: 'consolidated' | 'parent';
  eventPublishedAt: string;
  knowledgeCutoffAt: string;
  /** 上一期事实（MetricFact[]），用于跨期 currency 一致性诊断（算法第 11 步）。 */
  priorPeriodFacts?: MetricFact[];
  /** 测试/调度器注入的当前时间；默认取 knowledgeCutoffAt。 */
  now?: string;
}

export interface CandidateSummary {
  periodId: string;
  periodEndOn: string;
  fiscalPeriodType: FiscalPeriodType;
  provider: string;
  sourceNature: string;
  qualityTier: string;
  reasons: string[];
}

export interface RejectedCandidate {
  periodId?: string;
  factId?: string;
  metricCode?: string;
  reason: string;
}

export interface SelectionDiagnostics {
  expected: {
    instrumentId?: string;
    periodEndOn: string;
    periodType: ExpectedEarningsPeriodType;
    fiscalYear?: number;
    fiscalCalendarId?: string;
    accountingBasis?: string;
    scope?: string;
    eventPublishedAt: string;
    knowledgeCutoffAt: string;
  };
  candidatePeriods: CandidateSummary[];
  rejected: RejectedCandidate[];
  warnings: string[];
}

export type StructuredEarningsSelection =
  | {
      status: 'ready';
      period: FinancialPeriod;
      facts: MetricFact[];
      diagnostics: SelectionDiagnostics;
    }
  | {
      status: 'pending';
      reason: PendingReason;
      retryAt: string;
      diagnostics: SelectionDiagnostics;
    }
  | {
      status: 'ambiguous';
      reason: string;
      candidates: CandidateSummary[];
      facts: MetricFact[];
      diagnostics: SelectionDiagnostics;
    }
  | {
      status: 'unsupported';
      reason: string;
      diagnostics: SelectionDiagnostics;
    };

const BALANCE_METRIC_CODES = new Set<FinancialMetricCode>([
  'totalAssets',
  'totalLiabilities',
  'totalEquity',
  'cashAndCashEquivalents',
]);

const CASHFLOW_METRIC_CODES = new Set<FinancialMetricCode>([
  'operatingCashFlow',
  'capitalExpenditures',
  'freeCashFlow',
]);

const ALL_V2_METRIC_CODES: FinancialMetricCode[] = [
  'revenue',
  'costOfRevenue',
  'grossProfit',
  'operatingIncome',
  'netIncome',
  'netIncomeAttrib',
  'epsBasic',
  'epsDiluted',
  'operatingCashFlow',
  'capitalExpenditures',
  'freeCashFlow',
  'totalAssets',
  'totalLiabilities',
  'totalEquity',
  'cashAndCashEquivalents',
];

interface PeriodCompatRule {
  periodTypes: FiscalPeriodType[];
  accumulations: FlowAccumulation[];
  /** 同 metric 多候选时的偏好顺序（靠前优先）。 */
  preference: FlowAccumulation[];
}

/** 市场兼容表（§7）：按 metric 家族返回允许的 periodType × accumulation。 */
function compatRule(
  market: StructuredEarningsMarket,
  expectedPeriodType: ExpectedEarningsPeriodType,
  metricCode: FinancialMetricCode,
): PeriodCompatRule | null {
  if (BALANCE_METRIC_CODES.has(metricCode)) {
    // 任意市场资产负债表：instant，无 accumulation，不参与累计差分。
    return { periodTypes: ['Q1', 'Q2', 'Q3', 'Q4', 'H1', '9M', 'FY'], accumulations: [], preference: [] };
  }
  if (market === 'US') {
    switch (expectedPeriodType) {
      case 'Q1':
        return { periodTypes: ['Q1'], accumulations: ['discrete', 'YTD'], preference: ['discrete', 'YTD'] };
      case 'Q2':
      case 'Q3':
        if (CASHFLOW_METRIC_CODES.has(metricCode)) {
          // 10-Q 现金流通常只披露 YTD；discrete 仅在明确 reported 时接受。
          return {
            periodTypes: [expectedPeriodType],
            accumulations: ['YTD', 'discrete'],
            preference: ['YTD', 'discrete'],
          };
        }
        return {
          periodTypes: [expectedPeriodType],
          accumulations: ['discrete'],
          preference: ['discrete'],
        };
      case 'FY':
        return { periodTypes: ['FY'], accumulations: ['FY'], preference: ['FY'] };
      default:
        return null;
    }
  }
  if (market === 'CN') {
    switch (expectedPeriodType) {
      case 'Q1':
        return { periodTypes: ['Q1'], accumulations: ['discrete', 'YTD'], preference: ['discrete', 'YTD'] };
      case 'H1':
        return { periodTypes: ['H1'], accumulations: ['YTD'], preference: ['YTD'] };
      case 'Q3':
        return { periodTypes: ['9M', 'Q3'], accumulations: ['YTD'], preference: ['YTD'] };
      case 'FY':
        return { periodTypes: ['FY'], accumulations: ['FY'], preference: ['FY'] };
      default:
        return null;
    }
  }
  if (market === 'HK') {
    switch (expectedPeriodType) {
      case 'H1':
        return { periodTypes: ['H1'], accumulations: ['YTD'], preference: ['YTD'] };
      case '9M':
        return { periodTypes: ['9M'], accumulations: ['YTD'], preference: ['YTD'] };
      case 'FY':
        return { periodTypes: ['FY'], accumulations: ['FY'], preference: ['FY'] };
      default:
        return null;
    }
  }
  return null;
}

export function projectStructuredEarnings(
  input: StructuredEarningsSelectionInput,
): StructuredEarningsSelection {
  const diagnostics = buildDiagnostics(input);

  if (input.bundle.schemaVersion !== 'financials-v2') {
    return { status: 'unsupported', reason: 'schema_version_not_supported', diagnostics };
  }
  if (input.expectedInstrumentId && input.bundle.instrumentId !== input.expectedInstrumentId) {
    diagnostics.rejected.push({ reason: 'instrument_mismatch' });
    return { status: 'unsupported', reason: 'instrument_mismatch', diagnostics };
  }
  const rule = compatRule(input.market, input.expectedPeriodType, 'revenue');
  if (!rule) {
    return {
      status: 'unsupported',
      reason: `unsupported_period_type_${input.market}_${input.expectedPeriodType}`,
      diagnostics,
    };
  }

  // 1. 排除 TTM（本期不支持 TTM 作为事件主 actual；§7 算法第 2 步）。
  const periods = input.bundle.periods.filter((period) => period.fiscalPeriodType !== 'TTM');
  const ttmMatched = input.bundle.periods.filter(
    (period) => period.fiscalPeriodType === 'TTM' && period.periodEndOn === input.expectedPeriodEndOn,
  );
  for (const period of ttmMatched) {
    diagnostics.candidatePeriods.push(summaryOf(period, ['ttm_excluded']));
    diagnostics.rejected.push({ periodId: period.id, reason: 'ttm_excluded' });
  }

  // 2. 硬匹配 periodEndOn == expectedPeriodEndOn。
  const exact = periods.filter((period) => period.periodEndOn === input.expectedPeriodEndOn);
  for (const period of exact) {
    diagnostics.candidatePeriods.push(summaryOf(period, []));
  }
  if (exact.length === 0) {
    // 52/53 周财年提示：不宽容匹配，仅记录诊断。
    const sameFy = periods.filter((period) => period.fiscalYear === input.expectedFiscalYear);
    for (const period of sameFy) {
      diagnostics.warnings.push(
        `period ${period.id} fiscalYear matches but periodEndOn ${period.periodEndOn} != expected ${input.expectedPeriodEndOn}; fiscal calendar mapping requires calendar metadata`,
      );
    }
    return {
      status: 'pending',
      reason: 'no_exact_period',
      retryAt: defaultRetryAt(input),
      diagnostics,
    };
  }

  // 3. 按 expected accounting basis 过滤；未知 basis 不自动等同。
  let candidates = exact;
  if (input.expectedAccountingBasis) {
    const before = candidates;
    candidates = candidates.filter(
      (period) => period.accountingBasis === input.expectedAccountingBasis,
    );
    rejectPeriods(before, candidates, 'accounting_basis_mismatch', diagnostics);
  }

  // 4. 优先 consolidated；只有 event 明确 parent 时才选 parent。
  if (input.expectedScope === 'parent') {
    const before = candidates;
    candidates = candidates.filter((period) => period.reportingScope === 'parent');
    rejectPeriods(before, candidates, 'scope_not_parent', diagnostics);
  } else {
    const before = candidates;
    const consolidated = candidates.filter((period) => period.reportingScope === 'consolidated');
    if (consolidated.length > 0) {
      candidates = consolidated;
      rejectPeriods(before, candidates, 'scope_not_consolidated', diagnostics);
    } else {
      const unknown = candidates.filter((period) => period.reportingScope === 'unknown');
      candidates = unknown;
      if (unknown.length > 0) {
        diagnostics.warnings.push('no consolidated period; falling back to unknown scope');
      }
      rejectPeriods(before, candidates, 'scope_not_consolidated', diagnostics);
    }
  }

  // 5. period 级 cutoff：publishedAt/effectiveAt > knowledgeCutoffAt 的 revision 排除。
  const cutoff = input.knowledgeCutoffAt;
  {
    const before = candidates;
    candidates = candidates.filter((period) => {
      const periodTime = period.publishedAt ?? period.revision.effectiveAt;
      return !periodTime || periodTime <= cutoff;
    });
    rejectPeriods(before, candidates, 'cutoff_after', diagnostics);
  }

  if (candidates.length === 0) {
    return {
      status: 'pending',
      reason: 'no_compatible_period',
      retryAt: defaultRetryAt(input),
      diagnostics,
    };
  }

  // 6. 按 metric 选择。
  const facts: MetricFact[] = [];
  let ambiguousMetric: FinancialMetricCode | null = null;
  for (const metricCode of ALL_V2_METRIC_CODES) {
    const metricRule = compatRule(input.market, input.expectedPeriodType, metricCode);
    if (!metricRule) continue;
    const candidatesForMetric = collectCandidates(
      candidates,
      metricCode,
      metricRule,
      cutoff,
      diagnostics,
    );
    if (candidatesForMetric.length === 0) continue;
    const resolved = resolveAuthority(candidatesForMetric, metricRule, diagnostics);
    if (resolved.status === 'ambiguous') {
      ambiguousMetric = metricCode;
    }
    for (const fact of resolved.facts) {
      facts.push(toMetricFact(input.bundle, fact));
    }
  }

  if (facts.length === 0) {
    return { status: 'unsupported', reason: 'no_supported_metric', diagnostics };
  }

  checkCrossPeriodCurrency(facts, input.priorPeriodFacts, diagnostics);

  if (ambiguousMetric) {
    return {
      status: 'ambiguous',
      reason: `conflicting_metric_${ambiguousMetric}`,
      candidates: diagnostics.candidatePeriods,
      facts,
      diagnostics,
    };
  }

  return { status: 'ready', period: candidates[0], facts, diagnostics };
}

function buildDiagnostics(input: StructuredEarningsSelectionInput): SelectionDiagnostics {
  return {
    expected: {
      instrumentId: input.expectedInstrumentId ?? input.bundle.instrumentId,
      periodEndOn: input.expectedPeriodEndOn,
      periodType: input.expectedPeriodType,
      fiscalYear: input.expectedFiscalYear,
      fiscalCalendarId: input.fiscalCalendarId,
      accountingBasis: input.expectedAccountingBasis,
      scope: input.expectedScope,
      eventPublishedAt: input.eventPublishedAt,
      knowledgeCutoffAt: input.knowledgeCutoffAt,
    },
    candidatePeriods: [],
    rejected: [],
    warnings: [],
  };
}

function summaryOf(period: FinancialPeriod, reasons: string[]): CandidateSummary {
  return {
    periodId: period.id,
    periodEndOn: period.periodEndOn,
    fiscalPeriodType: period.fiscalPeriodType,
    provider: period.facts[0]?.provenance.provider ?? 'unknown',
    sourceNature: period.facts[0]?.provenance.sourceNature ?? 'unknown',
    qualityTier: period.facts[0]?.provenance.qualityTier ?? 'unknown',
    reasons,
  };
}

function rejectPeriods(
  before: FinancialPeriod[],
  after: FinancialPeriod[],
  reason: string,
  diagnostics: SelectionDiagnostics,
): void {
  const afterIds = new Set(after.map((period) => period.id));
  for (const period of before) {
    if (afterIds.has(period.id)) continue;
    diagnostics.rejected.push({ periodId: period.id, reason });
    const summary = diagnostics.candidatePeriods.find((c) => c.periodId === period.id);
    if (summary) summary.reasons.push(reason);
  }
}

function factCompatible(
  fact: FinancialFact,
  rule: PeriodCompatRule,
  periodType: FiscalPeriodType,
): boolean {
  if (BALANCE_METRIC_CODES.has(fact.metricCode)) {
    return fact.periodKind === 'instant' && fact.accumulation === undefined;
  }
  return (
    fact.periodKind === 'duration' &&
    fact.accumulation !== undefined &&
    rule.periodTypes.includes(periodType) &&
    rule.accumulations.includes(fact.accumulation)
  );
}

function collectCandidates(
  periods: FinancialPeriod[],
  metricCode: FinancialMetricCode,
  rule: PeriodCompatRule,
  cutoff: string,
  diagnostics: SelectionDiagnostics,
): FinancialFact[] {
  const out: FinancialFact[] = [];
  for (const period of periods) {
    for (const fact of period.facts) {
      if (fact.metricCode !== metricCode) continue;
      if (!factCompatible(fact, rule, period.fiscalPeriodType)) {
        diagnostics.rejected.push({
          periodId: period.id,
          factId: fact.id,
          metricCode,
          reason: 'market_compat_rejected',
        });
        continue;
      }
      if (fact.provenance.sourceFiledAt && fact.provenance.sourceFiledAt > cutoff) {
        diagnostics.rejected.push({
          periodId: period.id,
          factId: fact.id,
          metricCode,
          reason: 'fact_cutoff_after',
        });
        continue;
      }
      out.push(fact);
    }
  }
  return out;
}

function scaledValue(fact: FinancialFact): string {
  return new Decimal(fact.value).mul(fact.scale).toString();
}

interface ResolvedFacts {
  status: 'ok' | 'ambiguous';
  facts: FinancialFact[];
}

/**
 * 同一 metric 的 source authority policy（§7 算法第 9、13 步）：
 * - 同一 provider 内多个候选按 preference + 最新 filed 选一个；
 * - 跨 provider 按 qualityTier 取最高；
 * - 同级冲突：数值一致则合并（记录 warning），不一致返回 ambiguous。
 */
function resolveAuthority(
  candidates: FinancialFact[],
  rule: PeriodCompatRule,
  diagnostics: SelectionDiagnostics,
): ResolvedFacts {
  const byProvider = new Map<string, FinancialFact[]>();
  for (const fact of candidates) {
    const list = byProvider.get(fact.provenance.provider) ?? [];
    list.push(fact);
    byProvider.set(fact.provenance.provider, list);
  }

  const bestPerProvider: FinancialFact[] = [];
  for (const facts of byProvider.values()) {
    const sorted = [...facts].sort((a, b) => {
      const aPref = a.accumulation ? rule.preference.indexOf(a.accumulation) : -1;
      const bPref = b.accumulation ? rule.preference.indexOf(b.accumulation) : -1;
      if (aPref !== bPref) return aPref - bPref;
      const aFiled = a.provenance.sourceFiledAt ?? '';
      const bFiled = b.provenance.sourceFiledAt ?? '';
      if (aFiled !== bFiled) return aFiled < bFiled ? 1 : -1;
      return 0;
    });
    bestPerProvider.push(sorted[0]);
  }

  const tierOrder: Record<string, number> = { A: 0, B: 1, C: 2, D: 3, E: 4 };
  let bestTier = 4;
  for (const fact of bestPerProvider) {
    bestTier = Math.min(bestTier, tierOrder[fact.provenance.qualityTier] ?? 4);
  }
  const top = bestPerProvider.filter(
    (fact) => (tierOrder[fact.provenance.qualityTier] ?? 4) === bestTier,
  );

  if (top.length === 1) return { status: 'ok', facts: top };

  const values = new Set(top.map((fact) => scaledValue(fact)));
  if (values.size === 1) {
    diagnostics.warnings.push(
      `same-tier providers agree on value for ${top[0].metricCode}; using ${top[0].provenance.provider}`,
    );
    return { status: 'ok', facts: [top[0]] };
  }
  diagnostics.rejected.push({
    metricCode: top[0].metricCode,
    reason: 'same_tier_conflict',
  });
  return { status: 'ambiguous', facts: top };
}

function toMetricFact(bundle: FinancialsBundleV2, fact: FinancialFact): MetricFact {
  const normalizedValue = scaledValue(fact);
  return MetricFactSchema.parse({
    id: `${bundle.snapshotId}:${fact.id}`,
    metricCode: fact.metricCode as EarningsMetricCode,
    value: { kind: 'scalar', value: fact.value },
    normalizedValue: { kind: 'scalar', value: normalizedValue },
    unit: fact.unit,
    currency: fact.currency,
    scale: fact.scale,
    periodStartOn: fact.periodStartOn,
    periodEndOn: fact.periodEndOn,
    periodKind: fact.periodKind,
    // 遗留 card schema 要求 accumulation 必填；instant 在 v2 无 accumulation，此处映射为 discrete。
    accumulation: fact.periodKind === 'instant' ? 'discrete' : (fact.accumulation ?? 'discrete'),
    accountingBasis: fact.accountingBasis,
    consolidationScope: fact.reportingScope,
    derivation: fact.derivation,
    provenance: {
      kind: 'structuredSource',
      provider: fact.provenance.provider,
      sourceUrl: fact.provenance.sourceUrl,
      fieldPath: fact.provenance.sourceField,
      asOf: fact.provenance.retrievedAt,
    },
    comparisons: [],
    checkStatus: { status: 'passed', checks: ['financials_v2_schema', 'exact_period', 'market_compat'] },
    reconcileStatus: { status: 'not_applicable', reason: 'structured_first' },
  });
}

function checkCrossPeriodCurrency(
  facts: MetricFact[],
  priorPeriodFacts: MetricFact[] | undefined,
  diagnostics: SelectionDiagnostics,
): void {
  if (!priorPeriodFacts || priorPeriodFacts.length === 0) return;
  for (const fact of facts) {
    const prior = priorPeriodFacts.find(
      (candidate) =>
        candidate.metricCode === fact.metricCode &&
        candidate.periodKind === fact.periodKind &&
        candidate.accumulation === fact.accumulation,
    );
    if (!prior) continue;
    if ((prior.currency ?? '') !== (fact.currency ?? '')) {
      diagnostics.warnings.push(
        `currency changed for ${fact.metricCode}: ${prior.currency ?? 'none'} -> ${fact.currency ?? 'none'}; YOY comparison unavailable`,
      );
    }
  }
}

function defaultRetryAt(input: StructuredEarningsSelectionInput): string {
  const base = input.now ?? input.knowledgeCutoffAt;
  const baseMs = Date.parse(base);
  if (Number.isNaN(baseMs)) return base;
  const intervalMs = input.market === 'US' ? 12 * 60 * 60 * 1000 : 30 * 60 * 1000;
  return new Date(baseMs + intervalMs).toISOString();
}
