/**
 * Compute layer · red flags.
 *
 * Pattern detection on the FinancialsBundle + ComputedFinancialRatios.
 * Thresholds reference public academic literature (Sloan 1996 accrual ratio,
 * Beneish M-Score components, Altman Z-Score adjacent rules) so they survive
 * future code review without "I made it up" debt.
 *
 * Each rule:
 * - reads only fields it actually needs (no big-bag input contract)
 * - returns RedFlag with `evidence` capturing the triggering numbers
 * - silently skips when required inputs are missing — degraded analysis
 *   stays informative without false positives
 */

import type {
  FinancialsBundle,
  FinancialsLineItem,
  FinancialsPeriodEntry,
} from '../ports/financials';
import type { ComputedFinancialRatios } from './types';
import type { RedFlag } from './types';
import { readLine } from './read-bundle';

// ============================================================================
// Public API
// ============================================================================

export interface DetectRedFlagsInput {
  bundle: FinancialsBundle | null;
  ratios: ComputedFinancialRatios | null;
}

export function detectRedFlags(input: DetectRedFlagsInput): RedFlag[] {
  if (!input.bundle) return [];

  const flags: RedFlag[] = [];

  // Each rule short-circuits on null inputs.
  pushIfDefined(flags, accrualHigh(input.bundle));
  pushIfDefined(flags, arOutpacing(input.bundle));
  pushIfDefined(flags, goodwillConcentration(input.bundle));
  pushIfDefined(flags, fcfNiDivergence(input.bundle));
  pushIfDefined(flags, revenueStalling(input.bundle));
  pushIfDefined(flags, grossMarginDrop(input.bundle));
  pushIfDefined(flags, roeDrop(input.bundle, input.ratios));
  pushIfDefined(flags, interestCoverageLow(input.bundle));

  return flags;
}

function pushIfDefined(arr: RedFlag[], f: RedFlag | null): void {
  if (f) arr.push(f);
}

// ============================================================================
// Helpers
// ============================================================================

function fyPeriods(bundle: FinancialsBundle): FinancialsPeriodEntry[] {
  return bundle.periods.filter((p) => p.kind === 'FY');
}

/**
 * Read + normalize a line item to base unit. Thin wrapper over the canonical
 * warning-aware `readLine`: red-flags surfaces no `ComputeWarning[]` (its
 * contract returns only `RedFlag[]`), so any `unknown_unit` warning is
 * discarded into a throwaway sink — same numeric result as before, same
 * (empty) warning surface.
 */
function readVal(item: FinancialsLineItem | undefined): number | null {
  return readLine(item, '', []);
}

// ============================================================================
// Rules
// ============================================================================

/** Sloan ratio = (NI - OCF) / TotalAssets > 0.10 持续 2 期 */
function accrualHigh(bundle: FinancialsBundle): RedFlag | null {
  const fys = fyPeriods(bundle);
  if (fys.length < 2) return null;

  const computeAccrual = (p: FinancialsPeriodEntry): number | null => {
    const ni = readVal(p.income.netIncome);
    const ocf = readVal(p.cashFlow.operatingCashFlow);
    const ta = readVal(p.balance.totalAssets);
    if (ni === null || ocf === null || ta === null || ta === 0) return null;
    return (ni - ocf) / ta;
  };

  const a0 = computeAccrual(fys[0]!);
  const a1 = computeAccrual(fys[1]!);
  if (a0 === null || a1 === null) return null;
  if (a0 <= 0.1 || a1 <= 0.1) return null;

  return {
    rule: 'accrual_high',
    severity: 'medium',
    category: 'accounting',
    title: '应计比率连续 2 期偏高（Sloan ratio > 10%）',
    description: `${fys[0]!.fiscalPeriod} 应计比率 ${pct(a0)}, ${fys[1]!.fiscalPeriod} ${pct(a1)}。利润中应计成分高 → 盈余质量可能偏低（Sloan 1996）。`,
    evidence: { current: a0, prior: a1 },
  };
}

/** AR YoY > Revenue YoY × 2 (latest 2 FYs) — Beneish DSRI proxy */
function arOutpacing(bundle: FinancialsBundle): RedFlag | null {
  const fys = fyPeriods(bundle);
  if (fys.length < 2) return null;

  const ar0 = readVal(fys[0]!.balance.accountsReceivable);
  const ar1 = readVal(fys[1]!.balance.accountsReceivable);
  const rev0 = readVal(fys[0]!.income.revenue);
  const rev1 = readVal(fys[1]!.income.revenue);
  if (ar0 === null || ar1 === null || rev0 === null || rev1 === null) return null;
  if (ar1 === 0 || rev1 === 0) return null;

  const arYoY = (ar0 - ar1) / Math.abs(ar1);
  const revYoY = (rev0 - rev1) / Math.abs(rev1);
  // Trigger when both growth, AR outpaces revenue by ≥2x. Negative growth on
  // either side doesn't fit the "channel stuffing" pattern this rule targets.
  if (arYoY <= 0 || revYoY <= 0) return null;
  if (arYoY < revYoY * 2) return null;

  return {
    rule: 'ar_outpacing',
    severity: 'medium',
    category: 'accounting',
    title: `应收账款增速(${pct(arYoY)})显著快于营收增速(${pct(revYoY)})`,
    description: `${fys[1]!.fiscalPeriod} → ${fys[0]!.fiscalPeriod}：AR ${money(ar1)} → ${money(ar0)}, Revenue ${money(rev1)} → ${money(rev0)}。AR/Revenue 比恶化通常预示渠道压货 / 收入质量下降（Beneish DSRI）。`,
    evidence: {
      arYoY,
      revenueYoY: revYoY,
      latestAR: ar0,
      latestRevenue: rev0,
    },
  };
}

/** Goodwill / TotalAssets > 0.30 — impairment risk concentration */
function goodwillConcentration(bundle: FinancialsBundle): RedFlag | null {
  const fys = fyPeriods(bundle);
  if (fys.length < 1) return null;

  const gw = readVal(fys[0]!.balance.goodwill);
  const ta = readVal(fys[0]!.balance.totalAssets);
  if (gw === null || ta === null || ta === 0) return null;

  const ratio = gw / ta;
  if (ratio <= 0.3) return null;

  return {
    rule: 'goodwill_concentration',
    severity: 'high',
    category: 'accounting',
    title: `商誉占总资产 ${pct(ratio)}（>30% 阈值）`,
    description: `${fys[0]!.fiscalPeriod}：商誉 ${money(gw)} / 总资产 ${money(ta)}。商誉集中度高 → 一旦标的减值，账面权益冲击大；估值需对应折扣。`,
    evidence: { goodwill: gw, totalAssets: ta, ratio },
  };
}

/** NetIncome > 0 且 FreeCashFlow < 0 持续 2 期 */
function fcfNiDivergence(bundle: FinancialsBundle): RedFlag | null {
  const fys = fyPeriods(bundle);
  if (fys.length < 2) return null;

  const ni0 = readVal(fys[0]!.income.netIncome);
  const ni1 = readVal(fys[1]!.income.netIncome);
  const fcf0 = readVal(fys[0]!.cashFlow.freeCashFlow);
  const fcf1 = readVal(fys[1]!.cashFlow.freeCashFlow);
  if (ni0 === null || ni1 === null || fcf0 === null || fcf1 === null) return null;
  if (!(ni0 > 0 && fcf0 < 0 && ni1 > 0 && fcf1 < 0)) return null;

  return {
    rule: 'fcf_ni_divergence',
    severity: 'high',
    category: 'cash_flow',
    title: '净利为正但自由现金流连续 2 期为负',
    description: `${fys[0]!.fiscalPeriod} 净利 ${money(ni0)} / FCF ${money(fcf0)}；${fys[1]!.fiscalPeriod} 净利 ${money(ni1)} / FCF ${money(fcf1)}。账面盈利未变现为现金 → 资本开支或营运资本拖累，需关注持续性。`,
    evidence: {
      latestNetIncome: ni0,
      latestFreeCashFlow: fcf0,
      priorNetIncome: ni1,
      priorFreeCashFlow: fcf1,
    },
  };
}

/** Revenue YoY < 0 持续 2 期 (库存数据 not yet available) */
function revenueStalling(bundle: FinancialsBundle): RedFlag | null {
  const fys = fyPeriods(bundle);
  if (fys.length < 3) return null;

  const r0 = readVal(fys[0]!.income.revenue);
  const r1 = readVal(fys[1]!.income.revenue);
  const r2 = readVal(fys[2]!.income.revenue);
  if (r0 === null || r1 === null || r2 === null || r1 === 0 || r2 === 0) return null;

  const yoy0 = (r0 - r1) / Math.abs(r1);
  const yoy1 = (r1 - r2) / Math.abs(r2);
  if (yoy0 >= 0 || yoy1 >= 0) return null;

  return {
    rule: 'revenue_stalling',
    severity: 'medium',
    category: 'accounting',
    title: '营收连续 2 年同比下降',
    description: `${fys[0]!.fiscalPeriod} 营收 ${pct(yoy0)}, ${fys[1]!.fiscalPeriod} ${pct(yoy1)}。需排查需求侧、竞争或一次性影响。`,
    evidence: { latestYoY: yoy0, priorYoY: yoy1 },
  };
}

/** 毛利率同比下降 > 5pp */
function grossMarginDrop(bundle: FinancialsBundle): RedFlag | null {
  const fys = fyPeriods(bundle);
  if (fys.length < 2) return null;

  const m = (p: FinancialsPeriodEntry): number | null => {
    const r = readVal(p.income.revenue);
    const gp = readVal(p.income.grossProfit);
    if (r === null || gp === null || r === 0) return null;
    return gp / r;
  };

  const m0 = m(fys[0]!);
  const m1 = m(fys[1]!);
  if (m0 === null || m1 === null) return null;
  if (m1 - m0 <= 0.05) return null;

  return {
    rule: 'gross_margin_drop',
    severity: 'medium',
    category: 'accounting',
    title: `毛利率同比下降 ${pct(m1 - m0)}`,
    description: `${fys[1]!.fiscalPeriod} 毛利率 ${pct(m1)} → ${fys[0]!.fiscalPeriod} ${pct(m0)}。可能源于成本上升、定价压力或产品组合变化。`,
    evidence: { latest: m0, prior: m1, drop: m1 - m0 },
  };
}

/** ROE 同比下降 > 10pp */
function roeDrop(
  bundle: FinancialsBundle,
  _ratios: ComputedFinancialRatios | null,
): RedFlag | null {
  const fys = fyPeriods(bundle);
  if (fys.length < 2) return null;

  const r = (p: FinancialsPeriodEntry): number | null => {
    const ni = readVal(p.income.netIncome);
    const eq = readVal(p.balance.totalStockholdersEquity);
    if (ni === null || eq === null || eq === 0) return null;
    return ni / eq;
  };

  const r0 = r(fys[0]!);
  const r1 = r(fys[1]!);
  if (r0 === null || r1 === null) return null;
  if (r1 - r0 <= 0.1) return null;

  return {
    rule: 'roe_drop',
    severity: 'medium',
    category: 'accounting',
    title: `ROE 同比下降 ${pct(r1 - r0)}`,
    description: `${fys[1]!.fiscalPeriod} ROE ${pct(r1)} → ${fys[0]!.fiscalPeriod} ${pct(r0)}。盈利效率显著恶化。`,
    evidence: { latest: r0, prior: r1, drop: r1 - r0 },
  };
}

/** InterestCoverage = OperatingIncome / InterestExpense < 2.0 (Altman Z-Score
 * adjacent — companies covering interest <2x can't absorb a downturn before
 * the bond market reprices their debt). */
function interestCoverageLow(bundle: FinancialsBundle): RedFlag | null {
  const fys = fyPeriods(bundle);
  if (fys.length < 1) return null;

  const op = readVal(fys[0]!.income.operatingIncome);
  const ix = readVal(fys[0]!.income.interestExpense);
  if (op === null || ix === null || ix <= 0) return null;
  // Operating losses make coverage meaningless — separate signal.
  if (op <= 0) return null;

  const coverage = op / ix;
  if (coverage >= 2.0) return null;

  return {
    rule: 'interest_coverage_low',
    severity: 'high',
    category: 'cash_flow',
    title: `利息保障倍数 ${coverage.toFixed(2)}x（<2x 阈值）`,
    description: `${fys[0]!.fiscalPeriod}：营业利润 ${money(op)} / 利息费用 ${money(ix)}。覆盖率偏低 → 在加息或需求下行情景下偿债压力会快速恶化。`,
    evidence: { operatingIncome: op, interestExpense: ix, coverage },
  };
}

// ============================================================================
// Formatting helpers (used in description strings, not in evidence)
// ============================================================================

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function money(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(2)}K`;
  return n.toFixed(2);
}
