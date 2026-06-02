/**
 * Compute layer · financial ratios.
 *
 * Input: a `FinancialsBundle` from the financials port + an optional `Quote`.
 * Output: a fully-normalized `ComputedFinancialRatios` payload that LLM
 * prompts inject directly (no further math required downstream).
 *
 * Contract:
 * - All monetary values are first normalized via `compute/units` to base
 *   currency units (USD / CNY / HKD). Eastmoney's 万元 / 亿元 quirks are
 *   neutralized here.
 * - Every metric is independently nullable. Missing inputs do NOT throw —
 *   they surface as `null` + a `ComputeWarning` for `dataAvailability`.
 * - TTM-derived metrics prefer the TTM period; falls back to latest FY.
 * - YoY growth requires two comparable periods of the same `kind`.
 */

import type {
  FinancialsBundle,
  FinancialsPeriodEntry,
} from '../ports/financials';
import type { Quote } from '../ports/finance';
import {
  type ComputedFinancialRatios,
  type ComputeWarning,
  type PeriodTrend,
} from './types';
import { currencyForMarket, normalizeCurrency } from './units';
import {
  computeEnterpriseValue,
  normalizeQuoteMarketCap,
  pickAnchor,
  readLine,
  safeDiv,
  subNullable,
  sumNullable,
} from './read-bundle';

// ----------------------------------------------------------------------------
// Public API
// ----------------------------------------------------------------------------

export interface ComputeFinancialRatiosInput {
  bundle: FinancialsBundle | null;
  quote: Quote | null;
  market: 'US' | 'CN' | 'HK';
}

export interface ComputeFinancialRatiosResult {
  ratios: ComputedFinancialRatios | null;
  warnings: ComputeWarning[];
}

export function computeFinancialRatios(
  input: ComputeFinancialRatiosInput,
): ComputeFinancialRatiosResult {
  const warnings: ComputeWarning[] = [];

  if (!input.bundle || input.bundle.periods.length === 0) {
    return { ratios: null, warnings };
  }

  const baseCurrency =
    normalizeCurrency(input.bundle.currency) ?? currencyForMarket(input.market);

  // 1. Anchor periods
  const periods = input.bundle.periods;
  const latestFy = pickLatestFy(periods);
  const priorFy = pickPriorFy(periods, latestFy);
  // For ratio computation prefer TTM, fall back to latest FY.
  const anchor: FinancialsPeriodEntry | null = pickAnchor(periods);

  if (!anchor) {
    return { ratios: null, warnings };
  }

  const anchorIncome = readIncome(anchor, warnings);
  const anchorBalance = readBalance(anchor, warnings);
  const anchorCash = readCash(anchor, warnings);

  // 2. Quote-anchored metrics (require price + marketCap from a Quote)
  const quoteMarketCap = normalizeQuoteMarketCap(input.quote, input.market, warnings);
  const price = input.quote?.price ?? null;

  // ---- Estimation ---------------------------------------------------------
  const pe = safeDiv(quoteMarketCap, anchorIncome.netIncome, warnings, 'pe');
  const pb = safeDiv(quoteMarketCap, anchorBalance.totalEquity, warnings, 'pb');
  const ps = safeDiv(quoteMarketCap, anchorIncome.revenue, warnings, 'ps');
  const fcfYield = safeDiv(anchorCash.freeCashFlow, quoteMarketCap, warnings, 'fcfYield');

  // EV/EBITDA — we don't have EBITDA in current schema; approximate with
  // operatingIncome (rough). Return null when input missing.
  const enterpriseValue = computeEnterpriseValue(
    quoteMarketCap,
    anchorBalance.totalLiabilities,
    anchorBalance.cash,
  );
  const evToEbitda = safeDiv(enterpriseValue, anchorIncome.operatingIncome, warnings, 'evToEbitda');

  // ---- Profitability ------------------------------------------------------
  const grossMargin = safeDiv(anchorIncome.grossProfit, anchorIncome.revenue, warnings, 'grossMargin');
  const operatingMargin = safeDiv(anchorIncome.operatingIncome, anchorIncome.revenue, warnings, 'operatingMargin');
  const netMargin = safeDiv(anchorIncome.netIncome, anchorIncome.revenue, warnings, 'netMargin');
  const roe = safeDiv(anchorIncome.netIncome, anchorBalance.totalEquity, warnings, 'roe');

  // ROIC ≈ NOPAT / (Equity + LongTermDebt); we approximate NOPAT with
  // operatingIncome (no tax adj available in current schema).
  const investedCapital = sumNullable(anchorBalance.totalEquity, anchorBalance.longTermDebt);
  const roic = safeDiv(anchorIncome.operatingIncome, investedCapital, warnings, 'roic');

  const cashConversionRatio = safeDiv(anchorCash.operatingCashFlow, anchorIncome.netIncome, warnings, 'cashConversionRatio');

  // Accrual ratio = (NetIncome - OCF) / TotalAssets
  const accrualDiff = subNullable(anchorIncome.netIncome, anchorCash.operatingCashFlow);
  const accrualRatio = safeDiv(accrualDiff, anchorBalance.totalAssets, warnings, 'accrualRatio');

  // ---- Leverage -----------------------------------------------------------
  const debtToEquity = safeDiv(anchorBalance.totalLiabilities, anchorBalance.totalEquity, warnings, 'debtToEquity');
  const currentRatio = safeDiv(
    anchorBalance.currentAssets,
    anchorBalance.currentLiabilities,
    warnings,
    'currentRatio',
  );
  // Quick ratio = (Current Assets - Inventory) / Current Liabilities. Falls
  // back to null if either numerator term is missing — banks/utilities often
  // don't report inventory.
  const quickRatio =
    anchorBalance.currentAssets !== null && anchorBalance.inventory !== null
      ? safeDiv(
          anchorBalance.currentAssets - anchorBalance.inventory,
          anchorBalance.currentLiabilities,
          warnings,
          'quickRatio',
        )
      : null;
  // InterestCoverage = OperatingIncome / InterestExpense. Negative or zero
  // interest expense (net interest income for banks) → null (different metric).
  const interestCoverage =
    anchorIncome.interestExpense !== null && anchorIncome.interestExpense > 0
      ? safeDiv(
          anchorIncome.operatingIncome,
          anchorIncome.interestExpense,
          warnings,
          'interestCoverage',
        )
      : null;

  // ---- Growth -------------------------------------------------------------
  const revenueGrowthYoY = computeYoY(
    anchorIncome.revenue,
    readIncome(priorFy, warnings).revenue,
  );
  const earningsGrowthYoY = computeYoY(
    anchorIncome.netIncome,
    readIncome(priorFy, warnings).netIncome,
  );

  // 3y CAGR — needs revenue at t-3 (FY only)
  const allFy = periods.filter((p) => p.kind === 'FY');
  const revenueCagr3y = computeCagr(allFy, 'revenue', 3, warnings);
  const fcfCagr3y = computeCagrCash(allFy, 'freeCashFlow', 3, warnings);

  // ---- Period trends (for LLM to interpret trajectory) --------------------
  const periodTrends = buildPeriodTrends(periods, warnings);

  const ratios: ComputedFinancialRatios = {
    pe,
    pb,
    ps,
    fcfYield,
    evToEbitda,
    grossMargin,
    operatingMargin,
    netMargin,
    roe,
    roic,
    cashConversionRatio,
    accrualRatio,
    debtToEquity,
    currentRatio,
    quickRatio,
    interestCoverage,
    revenueGrowthYoY,
    earningsGrowthYoY,
    revenueCagr3y,
    fcfCagr3y,
    periodTrends,
    baseCurrency,
    computedAt: new Date().toISOString(),
  };

  // price referenced in EV computation; surface a non-fatal warning when missing
  if (price === null && quoteMarketCap === null) {
    warnings.push({
      code: 'missing_data',
      metric: 'quote',
      detail: 'Quote unavailable — valuation metrics (PE/PB/PS/FCFYield) will be null',
    });
  }

  return { ratios, warnings };
}

// ----------------------------------------------------------------------------
// Period anchoring
// ----------------------------------------------------------------------------

function pickLatestFy(periods: readonly FinancialsPeriodEntry[]): FinancialsPeriodEntry | null {
  return periods.find((p) => p.kind === 'FY') ?? null;
}

function pickPriorFy(
  periods: readonly FinancialsPeriodEntry[],
  latest: FinancialsPeriodEntry | null,
): FinancialsPeriodEntry | null {
  if (!latest) return null;
  const fys = periods.filter((p) => p.kind === 'FY');
  const idx = fys.indexOf(latest);
  return fys[idx + 1] ?? null;
}

// ----------------------------------------------------------------------------
// Read helpers — extract + normalize a line item to base unit
// ----------------------------------------------------------------------------

interface IncomeReadout {
  revenue: number | null;
  grossProfit: number | null;
  operatingIncome: number | null;
  netIncome: number | null;
  eps: number | null;
  interestExpense: number | null;
}
interface BalanceReadout {
  totalAssets: number | null;
  totalLiabilities: number | null;
  totalEquity: number | null;
  cash: number | null;
  longTermDebt: number | null;
  currentAssets: number | null;
  currentLiabilities: number | null;
  inventory: number | null;
}
interface CashReadout {
  operatingCashFlow: number | null;
  freeCashFlow: number | null;
}

function readIncome(p: FinancialsPeriodEntry | null, warnings: ComputeWarning[]): IncomeReadout {
  if (!p) {
    return {
      revenue: null,
      grossProfit: null,
      operatingIncome: null,
      netIncome: null,
      eps: null,
      interestExpense: null,
    };
  }
  return {
    revenue: readLine(p.income.revenue, 'revenue', warnings),
    grossProfit: readLine(p.income.grossProfit, 'grossProfit', warnings),
    operatingIncome: readLine(p.income.operatingIncome, 'operatingIncome', warnings),
    netIncome: readLine(p.income.netIncome, 'netIncome', warnings),
    eps: readLine(p.income.eps, 'eps', warnings),
    interestExpense: readLine(p.income.interestExpense, 'interestExpense', warnings),
  };
}

function readBalance(p: FinancialsPeriodEntry | null, warnings: ComputeWarning[]): BalanceReadout {
  if (!p) {
    return {
      totalAssets: null,
      totalLiabilities: null,
      totalEquity: null,
      cash: null,
      longTermDebt: null,
      currentAssets: null,
      currentLiabilities: null,
      inventory: null,
    };
  }
  return {
    totalAssets: readLine(p.balance.totalAssets, 'totalAssets', warnings),
    totalLiabilities: readLine(p.balance.totalLiabilities, 'totalLiabilities', warnings),
    totalEquity: readLine(p.balance.totalStockholdersEquity, 'totalEquity', warnings),
    cash: readLine(p.balance.cashAndCashEquivalents, 'cash', warnings),
    longTermDebt: readLine(p.balance.longTermDebt, 'longTermDebt', warnings),
    currentAssets: readLine(p.balance.currentAssets, 'currentAssets', warnings),
    currentLiabilities: readLine(p.balance.currentLiabilities, 'currentLiabilities', warnings),
    inventory: readLine(p.balance.inventory, 'inventory', warnings),
  };
}

function readCash(p: FinancialsPeriodEntry | null, warnings: ComputeWarning[]): CashReadout {
  if (!p) return { operatingCashFlow: null, freeCashFlow: null };
  return {
    operatingCashFlow: readLine(p.cashFlow.operatingCashFlow, 'operatingCashFlow', warnings),
    freeCashFlow: readLine(p.cashFlow.freeCashFlow, 'freeCashFlow', warnings),
  };
}

function computeYoY(current: number | null, prior: number | null): number | null {
  if (current === null || prior === null) return null;
  if (prior === 0) return null;
  return (current - prior) / Math.abs(prior);
}

function computeCagr(
  fys: readonly FinancialsPeriodEntry[],
  field: 'revenue',
  years: number,
  warnings: ComputeWarning[],
): number | null {
  if (fys.length < years + 1) {
    warnings.push({
      code: 'insufficient_history',
      metric: `${field}Cagr${years}y`,
      detail: `need ${years + 1} FY periods, have ${fys.length}`,
    });
    return null;
  }
  const latest = readLine(fys[0]!.income[field], field, warnings);
  const earliest = readLine(fys[years]!.income[field], field, warnings);
  if (latest === null || earliest === null || earliest <= 0) return null;
  return Math.pow(latest / earliest, 1 / years) - 1;
}

function computeCagrCash(
  fys: readonly FinancialsPeriodEntry[],
  field: 'freeCashFlow',
  years: number,
  warnings: ComputeWarning[],
): number | null {
  if (fys.length < years + 1) return null;
  const latest = readLine(fys[0]!.cashFlow[field], field, warnings);
  const earliest = readLine(fys[years]!.cashFlow[field], field, warnings);
  if (latest === null || earliest === null || earliest <= 0) return null;
  return Math.pow(latest / earliest, 1 / years) - 1;
}

// ----------------------------------------------------------------------------
// Period trends — one row per period for LLM to read trajectory
// ----------------------------------------------------------------------------

function buildPeriodTrends(
  periods: readonly FinancialsPeriodEntry[],
  warnings: ComputeWarning[],
): PeriodTrend[] {
  return periods.map((p) => {
    const income = readIncome(p, warnings);
    const cash = readCash(p, warnings);
    const grossMargin =
      income.grossProfit !== null && income.revenue !== null && income.revenue !== 0
        ? income.grossProfit / income.revenue
        : null;
    const netMargin =
      income.netIncome !== null && income.revenue !== null && income.revenue !== 0
        ? income.netIncome / income.revenue
        : null;
    return {
      period: p.fiscalPeriod,
      fiscalYearEnd: p.fiscalYearEnd,
      revenue: income.revenue,
      netIncome: income.netIncome,
      grossMargin,
      netMargin,
      operatingCashFlow: cash.operatingCashFlow,
    };
  });
}
