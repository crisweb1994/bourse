/**
 * TTM (Trailing Twelve Months) 派生。
 *
 * RFC Q3 决策：connector 内派生 TTM，避免 VALUATION dim 拿到 6 个月前的 FY
 * 数据算"半旧"P/E。
 *
 * 派生规则：
 * - TTM income / cashFlow = 最近 4 个连续 Q 求和
 * - TTM balance = 最新 Q 的 balance（balance 是时点不是区间，求和无意义）
 * - Q4 反算：公司只发 10-K 不发 Q4 10-Q，Q4 = FY - (Q1 + Q2 + Q3)
 *
 * 边界 case（抛 skippedReason，FY/Q 数据照常返回）：
 * - 重述报表 → 4 个 Q 里混了"原始 + 重述"
 * - 数据缺失 → 凑不齐 4 个连续 Q
 *
 * Pure function，零 IO，便于单测。
 */

import type {
  CashFlow,
  FinancialsLineItem,
  FinancialsPeriodEntry,
  IncomeStatement,
} from '../../ports/financials';

// ============================================================================
// 公共类型
// ============================================================================

export interface TtmDerivationResult {
  /** 成功派生时填充。 */
  ttmEntry?: FinancialsPeriodEntry;
  /** 跳过时填充原因；ttmEntry 同时 undefined。 */
  skippedReason?: string;
}

interface QuarterSlot {
  fy: number;
  fp: 'Q1' | 'Q2' | 'Q3' | 'Q4';
  entry: FinancialsPeriodEntry;
}

// ============================================================================
// 主入口
// ============================================================================

/**
 * 给定一组 FY + Q period entries（最新在前），尝试派生 TTM。
 *
 * 输入要求：periods 数组按 (fy desc, fp desc) 排好；FY entry 必须包含完整三表
 * （Q4 反算用）；Q entries 各自完整。
 *
 * 调用方应只把 FY/Q kind 的 entry 喂进来——不要传已有的 TTM entry（自循环）。
 */
export function deriveTTM(periods: FinancialsPeriodEntry[]): TtmDerivationResult {
  const quarters = collectLast4Quarters(periods);
  if ('skippedReason' in quarters) {
    return { skippedReason: quarters.skippedReason };
  }

  // 求和 income + cashFlow
  const income = sumIncomeStatements(quarters.slots.map((q) => q.entry.income));
  const cashFlow = sumCashFlows(quarters.slots.map((q) => q.entry.cashFlow));

  // FreeCashFlow 派生：OCF - CapEx（如果两项都有）
  if (cashFlow.operatingCashFlow && cashFlow.capitalExpenditures) {
    cashFlow.freeCashFlow = {
      value: cashFlow.operatingCashFlow.value - cashFlow.capitalExpenditures.value,
      unit: cashFlow.operatingCashFlow.unit,
    };
  }

  // Balance 取最新 Q 的（quarters.slots[0] 是最新）
  const latestSlot = quarters.slots[0];
  const balance = latestSlot.entry.balance;

  // TTM label：'TTM-as-of-Q3-FY2025' 这种
  const label = `TTM-as-of-${latestSlot.fp}-FY${latestSlot.fy}`;
  const derivedFromPeriods = quarters.slots.map(
    (q) => `${q.fp}-FY${q.fy}`,
  );

  const ttmEntry: FinancialsPeriodEntry = {
    fiscalPeriod: label,
    kind: 'TTM',
    fiscalYearEnd: latestSlot.entry.fiscalYearEnd,
    filed: latestSlot.entry.filed,
    formType: 'derived-TTM',
    income,
    balance,
    cashFlow,
    derivedFromPeriods,
  };
  return { ttmEntry };
}

// ============================================================================
// Internals
// ============================================================================

/**
 * 从 periods 数组拼出最近 4 个连续 Q：
 *   优先用显式 Q (10-Q)；
 *   当最新 FY 后没有任何 Q，用 FY 的最后一个 Q4 反算 (FY - Q1 - Q2 - Q3)。
 *
 * 失败返回 skippedReason。
 */
function collectLast4Quarters(
  periods: FinancialsPeriodEntry[],
):
  | { slots: QuarterSlot[] }
  | { skippedReason: string } {
  const quartersOnly = periods.filter((p) => p.kind === 'Q');
  const fysOnly = periods.filter((p) => p.kind === 'FY');

  if (quartersOnly.length === 0) {
    return { skippedReason: 'insufficient quarters: 0/4 (no 10-Q in window)' };
  }

  // Parse 'Q3-FY2024' / 'Q1-FY2025' → (fy, fp) 元信息
  const parsed: QuarterSlot[] = [];
  for (const q of quartersOnly) {
    const m = /^Q([1-4])-FY(\d{4})$/.exec(q.fiscalPeriod);
    if (!m) continue;
    parsed.push({
      fy: parseInt(m[2], 10),
      fp: `Q${m[1]}` as 'Q1' | 'Q2' | 'Q3' | 'Q4',
      entry: q,
    });
  }
  // 已按时间降序排（periods 入参排序保证）。

  // Pick anchor (the latest "data point"): the more recent of latestQ and
  // latestFY (compared by filed date). Just-filed 10-K → Q4 of that FY is
  // the anchor (derivable from FY - Q1 - Q2 - Q3). Just-filed 10-Q → that
  // Q is the anchor.
  const anchor = pickAnchor(parsed, fysOnly);
  if (!anchor) {
    return { skippedReason: 'no anchor: empty quarter + fy sets' };
  }

  // Build 4-slot window walking back from anchor.
  const target = buildTargetWindow(anchor);
  const slots: QuarterSlot[] = [];
  for (const t of target) {
    const explicit = parsed.find((p) => p.fy === t.fy && p.fp === t.fp);
    if (explicit) {
      slots.push(explicit);
      continue;
    }
    // Q4 reverse-derivation: needs FY entry + Q1+Q2+Q3 of that fy.
    if (t.fp === 'Q4') {
      const fyEntry = fysOnly.find((f) => parseFy(f.fiscalPeriod) === t.fy);
      if (!fyEntry) {
        return { skippedReason: `Q4-FY${t.fy} missing and no FY${t.fy} entry to reverse-derive from` };
      }
      const q1 = parsed.find((p) => p.fy === t.fy && p.fp === 'Q1');
      const q2 = parsed.find((p) => p.fy === t.fy && p.fp === 'Q2');
      const q3 = parsed.find((p) => p.fy === t.fy && p.fp === 'Q3');
      if (!q1 || !q2 || !q3) {
        const missing = (['Q1', 'Q2', 'Q3'] as const).filter((_, i) => ![q1, q2, q3][i]).join('+');
        return { skippedReason: `Q4-FY${t.fy} reverse-derivation needs ${missing}-FY${t.fy} (not in bundle)` };
      }
      const q4Entry = deriveQ4FromFy(fyEntry, [q1.entry, q2.entry, q3.entry]);
      if (!q4Entry) {
        return { skippedReason: `Q4-FY${t.fy} derivation failed (FY missing required line items)` };
      }
      slots.push({ fy: t.fy, fp: 'Q4', entry: q4Entry });
      continue;
    }
    return { skippedReason: `Q${t.fp.slice(1)}-FY${t.fy} missing from bundle (gap before anchor)` };
  }
  return { slots };
}

/**
 * Build the 4-slot TTM window walking back from `anchor`. Slots are returned
 * latest-first: [anchor, anchor-1, anchor-2, anchor-3]. Crossing a fiscal
 * year boundary wraps Q1 → Q4 of previous year.
 */
function buildTargetWindow(
  anchor: { fy: number; fp: 'Q1' | 'Q2' | 'Q3' | 'Q4' },
): Array<{ fy: number; fp: 'Q1' | 'Q2' | 'Q3' | 'Q4' }> {
  const order: Array<'Q1' | 'Q2' | 'Q3' | 'Q4'> = ['Q1', 'Q2', 'Q3', 'Q4'];
  const out: Array<{ fy: number; fp: 'Q1' | 'Q2' | 'Q3' | 'Q4' }> = [
    { fy: anchor.fy, fp: anchor.fp },
  ];
  let fy = anchor.fy;
  let i = order.indexOf(anchor.fp);
  for (let k = 0; k < 3; k++) {
    i--;
    if (i < 0) {
      i = 3;
      fy--;
    }
    out.push({ fy, fp: order[i] });
  }
  return out;
}

/**
 * Anchor selection: the most recent reported data point.
 *
 * Rules (first match wins):
 *   1. No quarters at all → no anchor (caller will skip).
 *   2. Latest FY year strictly newer than latest Q year → anchor = Q4 of FY
 *      (just-filed 10-K with no 10-Q yet for the new fiscal year).
 *   3. Latest FY year ≥ latest Q year AND latest Q is not Q4 of that FY
 *      AND that FY has Q1+Q2+Q3 in the parsed set → anchor = Q4 of FY
 *      (10-K closes the year after Q3 10-Q; Q4 is the freshest data).
 *   4. Otherwise → anchor = latest Q.
 *
 * Filed date isn't reliable across all data sources (some companies file
 * 10-K and 10-Q on the same day or in unpredictable order), so we use the
 * fiscal calendar relationship instead — it's deterministic.
 */
function pickAnchor(
  parsed: QuarterSlot[],
  fysOnly: FinancialsPeriodEntry[],
): { fy: number; fp: 'Q1' | 'Q2' | 'Q3' | 'Q4' } | null {
  const latestQ = parsed[0];
  const latestFy = fysOnly[0];
  if (!latestQ && !latestFy) return null;
  if (latestFy) {
    const fyYear = parseFy(latestFy.fiscalPeriod);
    if (fyYear !== null) {
      // Rule 2: no quarters, or FY year newer than latest Q's year.
      if (!latestQ || fyYear > latestQ.fy) {
        return { fy: fyYear, fp: 'Q4' };
      }
      // Rule 3: FY year matches latest Q's year, latest Q isn't Q4, and
      // we have Q1+Q2+Q3 of that FY to enable Q4 reverse-derivation.
      if (fyYear === latestQ.fy && latestQ.fp !== 'Q4') {
        const hasQ123 =
          parsed.some((p) => p.fy === fyYear && p.fp === 'Q1') &&
          parsed.some((p) => p.fy === fyYear && p.fp === 'Q2') &&
          parsed.some((p) => p.fy === fyYear && p.fp === 'Q3');
        if (hasQ123) return { fy: fyYear, fp: 'Q4' };
      }
    }
  }
  if (latestQ) return { fy: latestQ.fy, fp: latestQ.fp };
  return null;
}

/** Parse 'FY2024' → 2024; returns null on shape mismatch. */
function parseFy(fiscalPeriod: string): number | null {
  const m = /^FY(\d{4})$/.exec(fiscalPeriod);
  return m ? parseInt(m[1], 10) : null;
}

// ============================================================================
// Q4 反算
// ============================================================================

function deriveQ4FromFy(
  fy: FinancialsPeriodEntry,
  q123: FinancialsPeriodEntry[],
): FinancialsPeriodEntry | null {
  // Income / CashFlow 按字段反算；任一关键字段缺失 → 返回 null（caller 标 skipped）
  const income = subIncomeStatement(fy.income, q123.map((q) => q.income));
  const cashFlow = subCashFlow(fy.cashFlow, q123.map((q) => q.cashFlow));

  // FreeCashFlow 派生
  if (cashFlow.operatingCashFlow && cashFlow.capitalExpenditures) {
    cashFlow.freeCashFlow = {
      value: cashFlow.operatingCashFlow.value - cashFlow.capitalExpenditures.value,
      unit: cashFlow.operatingCashFlow.unit,
    };
  }

  // 至少需要 revenue + netIncome + OCF 三项有效，否则反算结果没意义
  if (!income.revenue || !income.netIncome || !cashFlow.operatingCashFlow) {
    return null;
  }

  // Period 元信息：fiscalYearEnd = FY 的 end；filed 也用 FY 的（10-K filed date）
  const fyMatch = /^FY(\d{4})$/.exec(fy.fiscalPeriod);
  const fyYear = fyMatch ? parseInt(fyMatch[1], 10) : 0;
  return {
    fiscalPeriod: `Q4-FY${fyYear}`,
    kind: 'Q',
    fiscalYearEnd: fy.fiscalYearEnd,
    filed: fy.filed,
    formType: '10-K',
    income,
    balance: fy.balance, // FY 期末 balance 即 Q4 期末
    cashFlow,
  };
}

// ============================================================================
// Line item 算术
// ============================================================================

function addLineItems(items: Array<FinancialsLineItem | undefined>): FinancialsLineItem | undefined {
  const present = items.filter((x): x is FinancialsLineItem => x !== undefined);
  if (present.length === 0) return undefined;
  // 单位必须一致才能加；不一致返回 undefined（保守，避免错值）
  const unit = present[0].unit;
  if (!present.every((p) => p.unit === unit)) return undefined;
  return {
    value: present.reduce((sum, p) => sum + p.value, 0),
    unit,
  };
}

function subLineItems(
  whole: FinancialsLineItem | undefined,
  parts: Array<FinancialsLineItem | undefined>,
): FinancialsLineItem | undefined {
  if (!whole) return undefined;
  const presentParts = parts.filter((x): x is FinancialsLineItem => x !== undefined);
  // 任一 part 缺失（部分公司不报某些项）则返回 undefined
  if (presentParts.length !== parts.length) return undefined;
  if (!presentParts.every((p) => p.unit === whole.unit)) return undefined;
  return {
    value: whole.value - presentParts.reduce((sum, p) => sum + p.value, 0),
    unit: whole.unit,
  };
}

function sumIncomeStatements(statements: IncomeStatement[]): IncomeStatement {
  return {
    revenue: addLineItems(statements.map((s) => s.revenue)),
    costOfRevenue: addLineItems(statements.map((s) => s.costOfRevenue)),
    grossProfit: addLineItems(statements.map((s) => s.grossProfit)),
    operatingIncome: addLineItems(statements.map((s) => s.operatingIncome)),
    netIncome: addLineItems(statements.map((s) => s.netIncome)),
    // EPS 不能简单加 4 个 Q —— 应该用 TTM NetIncome / 当期 share count。
    // Phase 1 简化：取 TTM netIncome / TTM weightedAvgShares（如果有的话）；
    // 没有 share count 时 eps 留 undefined，dim prompt 自己算。
    // 但 dim 拿不到 share count 就无法算 EPS。Phase 1 选保守：留空，让 dim
    // 看到 facts.financials.periods[].income.eps 是 undefined 时回退 FY EPS。
    eps: undefined,
  };
}

function subIncomeStatement(
  fy: IncomeStatement,
  q123: IncomeStatement[],
): IncomeStatement {
  return {
    revenue: subLineItems(fy.revenue, q123.map((q) => q.revenue)),
    costOfRevenue: subLineItems(fy.costOfRevenue, q123.map((q) => q.costOfRevenue)),
    grossProfit: subLineItems(fy.grossProfit, q123.map((q) => q.grossProfit)),
    operatingIncome: subLineItems(fy.operatingIncome, q123.map((q) => q.operatingIncome)),
    netIncome: subLineItems(fy.netIncome, q123.map((q) => q.netIncome)),
    // EPS：FY EPS 是当年 weighted avg，Q4 EPS 反算无统一定义。留空。
    eps: undefined,
  };
}

function sumCashFlows(flows: CashFlow[]): CashFlow {
  return {
    operatingCashFlow: addLineItems(flows.map((f) => f.operatingCashFlow)),
    investingCashFlow: addLineItems(flows.map((f) => f.investingCashFlow)),
    financingCashFlow: addLineItems(flows.map((f) => f.financingCashFlow)),
    capitalExpenditures: addLineItems(flows.map((f) => f.capitalExpenditures)),
    // freeCashFlow 由调用方在 sum 完之后派生（OCF - CapEx），sum 阶段不算。
    freeCashFlow: undefined,
  };
}

function subCashFlow(fy: CashFlow, q123: CashFlow[]): CashFlow {
  return {
    operatingCashFlow: subLineItems(fy.operatingCashFlow, q123.map((q) => q.operatingCashFlow)),
    investingCashFlow: subLineItems(fy.investingCashFlow, q123.map((q) => q.investingCashFlow)),
    financingCashFlow: subLineItems(fy.financingCashFlow, q123.map((q) => q.financingCashFlow)),
    capitalExpenditures: subLineItems(fy.capitalExpenditures, q123.map((q) => q.capitalExpenditures)),
    freeCashFlow: undefined, // 由调用方派生
  };
}
